require("dotenv").config();
const path = require("path");
const express = require("express");
const multer = require("multer");
const mysql = require("mysql2/promise");
const OpenAI = require("openai");
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require("docx");

const PORT = process.env.PORT || 4000;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "openai/gpt-oss-120b";
// Groq's free tier caps tokens-per-minute (often 8000). The request reserves
// input + max_completion_tokens against that cap, so keep the output budget
// modest. Override with OPENAI_MAX_TOKENS if you're on a paid tier.
const MAX_TOKENS = Number(process.env.OPENAI_MAX_TOKENS) || 5000;

const app = express();
// Icons are sent as base64 data URLs, so allow a larger JSON body than the 100kb default.
app.use(express.json({ limit: "16mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// MySQL — stores the Mobile Application Portfolio
// ---------------------------------------------------------------------------
const MYSQL = {
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "railway",
};
// Treat MySQL as "configured" when connection details are present in .env.
const DB_CONFIGURED = Boolean(process.env.MYSQL_HOST || process.env.MYSQL_USER || process.env.MYSQL_DATABASE);
let pool = null;
let dbReady = false;

async function initMysql() {
  if (!DB_CONFIGURED) {
    console.log("   Portfolio DB: MySQL not configured — /api/portfolio is disabled");
    return;
  }
  try {
    // Best-effort: create the database if it doesn't exist. On a remote server
    // whose user lacks CREATE privileges this will fail — that's fine as long as
    // the database already exists (we connect to it directly below).
    try {
      const admin = await mysql.createConnection({
        host: MYSQL.host,
        port: MYSQL.port,
        user: MYSQL.user,
        password: MYSQL.password,
      });
      await admin.query(`CREATE DATABASE IF NOT EXISTS \`${MYSQL.database}\``);
      await admin.end();
    } catch (e) {
      console.warn("   Portfolio DB: could not auto-create database (will assume it exists) —", e.message);
    }

    pool = mysql.createPool({
      host: MYSQL.host,
      port: MYSQL.port,
      user: MYSQL.user,
      password: MYSQL.password,
      database: MYSQL.database,
     waitForConnections: true,

  connectionLimit: 10,

  connectTimeout: 30000,

  ssl: {

    rejectUnauthorized: false,

  },
    });

    // features/techStack are stored as JSON strings in TEXT columns (portable
    // across MySQL 5.6+/8 and MariaDB). icon is a base64 data URL (LONGTEXT).
    await pool.query(`CREATE TABLE IF NOT EXISTS portfolio (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      appName VARCHAR(80) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Live',
      domain VARCHAR(60),
      shortDescription VARCHAR(240),
      features TEXT,
      techStack TEXT,
      appStoreUrl VARCHAR(300),
      playStoreUrl VARCHAR(300),
      figmaUrl VARCHAR(300),
      icon LONGTEXT,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    dbReady = true;
    console.log("   Portfolio DB: connected to MySQL ✅");
  } catch (e) {
    console.error("   Portfolio DB: MySQL connection failed —", e.message);
  }
}
initMysql();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 6, fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only PNG, JPEG, WebP or GIF images are allowed"));
  },
});

// Provider is auto-detected from the key. A "gsk_" key is a Groq key, so we
// point the OpenAI SDK at Groq's OpenAI-compatible endpoint. Override the
// endpoint explicitly with OPENAI_BASE_URL. Never hardcode the key.
const API_KEY = process.env.OPENAI_API_KEY || "";
const IS_GROQ = API_KEY.startsWith("gsk_");
const BASE_URL = process.env.OPENAI_BASE_URL || (IS_GROQ ? "https://api.groq.com/openai/v1" : undefined);
const PROVIDER = IS_GROQ ? "Groq" : "OpenAI";
const openai = API_KEY ? new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL }) : null;

// Text-only models (e.g. gpt-oss) can't accept image input, so we skip
// screenshots for them rather than sending an image the model will reject.
function modelSupportsVision(model) {
  return /vision|llava|llama-?4|scout|maverick|gpt-4o|gpt-4\.1|o1|o3|o4|pixtral|gemini|vl\b/i.test(model);
}

// Real store category lists (from the submission sheets). Used both as schema
// enums (so the model can only pick a valid category) and in the prompt.
const APPLE_CATEGORIES = [
  "Book", "Business", "Education", "Entertainment", "Finance", "Game",
  "Health & Fitness", "Lifestyle", "Medical", "Music", "Navigation", "News",
  "Photo & Video", "Productivity", "Reference", "Social Networking", "Sports",
  "Travel", "Utilities", "Weather", "Developer Tools", "Food & Drink",
  "Graphics & Design", "Magazines & Newspapers", "Shopping", "Stickers",
];
const GOOGLE_CATEGORIES = [
  "Art & Design", "Auto & Vehicles", "Beauty", "Books & Reference", "Business",
  "Comics", "Communication", "Dating", "Education", "Entertainment", "Events",
  "Finance", "Food & Drink", "Health & Fitness", "House & Home",
  "Libraries & Demo", "Lifestyle", "Maps & Navigation", "Medical",
  "Music & Audio", "News & Magazines", "Parenting", "Personalization",
  "Photography", "Productivity", "Shopping", "Social", "Sports", "Tools",
  "Travel & Local",
];
const APPLE_AGE_RATINGS = ["4+", "9+", "12+", "17+"];
const GOOGLE_CONTENT_RATINGS = ["Everyone", "Everyone 10+", "Teen", "Mature 17+", "Adults only 18+"];
const CURRENT_YEAR = new Date().getFullYear();

// ---------------------------------------------------------------------------
// Structured output schema (OpenAI strict mode: every object lists all keys in
// `required` and sets additionalProperties:false)
// ---------------------------------------------------------------------------
const LISTING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "appName",
    "tagline",
    "categorySuggestion",
    "appStore",
    "googlePlay",
    "keywords",
    "releaseNotes",
    "faqs",
    "privacy",
    "privacyPolicy",
    "termsOfService",
    "screenshotCaptions",
    "asoTips",
  ],
  properties: {
    appName: { type: "string" },
    tagline: { type: "string", description: "Catchy one-line tagline" },
    categorySuggestion: {
      type: "string",
      description: "Best-fit store category, e.g. 'Productivity'",
    },
    appStore: {
      type: "object",
      additionalProperties: false,
      required: [
        "title",
        "subtitle",
        "promotionalText",
        "description",
        "keywords",
        "primaryCategory",
        "subcategory",
        "ageRating",
        "copyright",
        "whatsNew",
      ],
      properties: {
        title: { type: "string", description: "Apple App Store name/title, max 30 characters" },
        subtitle: { type: "string", description: "Summary shown under the name, max 30 characters" },
        promotionalText: { type: "string", description: "Promotional text, max 170 characters" },
        description: {
          type: "string",
          description:
            "Compelling description up to 4000 characters with short paragraphs and a bulleted feature list",
        },
        keywords: {
          type: "string",
          description:
            "Apple keyword field: comma-separated, no spaces after commas, max 100 characters total",
        },
        primaryCategory: {
          type: "string",
          enum: APPLE_CATEGORIES,
          description: "Best-fit Apple App Store category",
        },
        subcategory: {
          type: "string",
          enum: APPLE_CATEGORIES,
          description: "Second-best Apple category; must differ from primaryCategory",
        },
        ageRating: {
          type: "string",
          enum: APPLE_AGE_RATINGS,
          description: "Apple age rating",
        },
        copyright: { type: "string", description: "Copyright line, e.g. © 2026 Company" },
        whatsNew: { type: "string", description: "What's New / version notes text" },
      },
    },
    googlePlay: {
      type: "object",
      additionalProperties: false,
      required: [
        "title",
        "shortDescription",
        "fullDescription",
        "keywords",
        "primaryCategory",
        "subcategory",
        "contentRating",
        "copyright",
        "whatsNew",
      ],
      properties: {
        title: { type: "string", description: "Google Play title, max 30 characters" },
        shortDescription: { type: "string", description: "Max 80 characters" },
        fullDescription: {
          type: "string",
          description: "Up to 4000 characters, engaging, with feature bullets",
        },
        keywords: {
          type: "string",
          description: "8-12 comma-separated search keywords in priority order",
        },
        primaryCategory: {
          type: "string",
          enum: GOOGLE_CATEGORIES,
          description: "Best-fit Google Play category",
        },
        subcategory: {
          type: "string",
          enum: GOOGLE_CATEGORIES,
          description: "Second-best Google Play category; must differ from primaryCategory",
        },
        contentRating: {
          type: "string",
          enum: GOOGLE_CONTENT_RATINGS,
          description: "Google Play content rating",
        },
        copyright: { type: "string", description: "Copyright line, e.g. © 2026 Company" },
        whatsNew: { type: "string", description: "Release notes for the Play listing" },
      },
    },
    keywords: {
      type: "array",
      items: { type: "string" },
      description: "15-25 ASO keywords/phrases ranked by relevance",
    },
    releaseNotes: { type: "string", description: "General release notes text" },
    faqs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "answer"],
        properties: {
          question: { type: "string" },
          answer: { type: "string" },
        },
      },
      description: "5-8 frequently asked questions with answers",
    },
    privacy: {
      type: "object",
      additionalProperties: false,
      required: ["dataCollected", "privacyPolicySummary", "privacyNutritionLabel"],
      properties: {
        dataCollected: {
          type: "array",
          items: { type: "string" },
          description: "Data types the app likely collects",
        },
        privacyPolicySummary: {
          type: "string",
          description: "Plain-language privacy summary suitable for a store listing",
        },
        privacyNutritionLabel: {
          type: "array",
          items: { type: "string" },
          description: "Apple privacy nutrition label categories that likely apply",
        },
      },
    },
    privacyPolicy: {
      type: "string",
      description:
        "A complete but concise, ready-to-adapt Privacy Policy in plain language with clear section headings (Information We Collect, How We Use It, Sharing, Data Retention, Security, Your Rights, Children's Privacy, Changes, Contact). Use bracketed placeholders like [Company Name], [contact email], [effective date], [jurisdiction] where specifics are unknown.",
    },
    termsOfService: {
      type: "string",
      description:
        "A complete but concise, ready-to-adapt Terms of Service / Terms & Conditions in plain language with clear section headings (Acceptance, License to Use, User Responsibilities, Prohibited Conduct, Intellectual Property, Disclaimers, Limitation of Liability, Termination, Governing Law, Changes, Contact). Use bracketed placeholders like [Company Name], [contact email], [effective date], [jurisdiction] where specifics are unknown.",
    },
    screenshotCaptions: {
      type: "array",
      items: { type: "string" },
      description: "One marketing caption per uploaded screenshot (empty if none)",
    },
    asoTips: {
      type: "array",
      items: { type: "string" },
      description: "5-8 actionable App Store Optimization tips for this app",
    },
  },
};

function buildPrompt(fields, screenshotCount) {
  const lines = [
    "Generate a complete, publish-ready App Store and Google Play listing for the app described below.",
    "",
    `App name: ${fields.appName}`,
    `Company / developer name: ${fields.companyName || "the developer"}`,
    `Platform target: ${fields.platform || "both iOS and Android"}`,
    fields.category ? `Category hint: ${fields.category}` : null,
    `What the app does: ${fields.description}`,
    fields.features ? `Key features: ${fields.features}` : null,
    fields.audience ? `Target audience: ${fields.audience}` : null,
    fields.pricing ? `Pricing model: ${fields.pricing}` : null,
    fields.keywordsHint ? `Keyword ideas from the developer: ${fields.keywordsHint}` : null,
    fields.whatsNew ? `Changes in this release: ${fields.whatsNew}` : null,
    "",
    `Output language: ${fields.language || "English"}`,
    "",
    screenshotCount > 0
      ? `${screenshotCount} app screenshot(s) are attached. Use them to understand the UI and real features, and write one marketing caption per screenshot (in order).`
      : "No screenshots were provided; return an empty screenshotCaptions array.",
    "",
    "Hard character limits you must respect:",
    "- appStore.title and appStore.subtitle: 30 characters each",
    "- appStore.promotionalText: 170 characters",
    "- appStore.keywords: 100 characters total, comma-separated, no spaces after commas",
    "- googlePlay.title: 30 characters",
    "- googlePlay.shortDescription: 80 characters",
    "- descriptions: aim for 1500-2500 characters (keep them tight, not the full 4000)",
    "",
    "For each store pick primaryCategory, subcategory (must differ from primary), and the store's rating ONLY from the allowed values defined in the schema.",
    fields.copyright
      ? `Use this exact copyright line for both stores: ${fields.copyright}`
      : `Copyright line for both stores: © ${CURRENT_YEAR} ${fields.companyName || "[Company Name]"}`,
    "",
    "Also produce a privacyPolicy and a termsOfService. Keep each concise (roughly 200-300 words), plain-language, and ready to adapt, using bracketed placeholders like [Company Name], [contact email], [effective date], and [jurisdiction] wherever specifics are unknown. Keep total output compact so it fits the response budget.",
  ];
  return lines.filter((l) => l !== null).join("\n");
}

const SYSTEM_PROMPT =
  "You are an expert App Store Optimization (ASO) copywriter. You write conversion-focused, honest store listings that strictly respect platform character limits. Never invent features that contradict the provided details or screenshots. Respond with a single JSON object and nothing else.";

// Ask for strict json_schema first (best on OpenAI). If the provider/model
// rejects it (many OpenAI-compatible endpoints don't support strict schemas),
// fall back to json_object mode with the schema embedded in the prompt.
async function createCompletion(messages) {
  const base = { model: OPENAI_MODEL, max_completion_tokens: MAX_TOKENS };
  try {
    return await openai.chat.completions.create({
      ...base,
      messages,
      response_format: {
        type: "json_schema",
        json_schema: { name: "app_store_listing", strict: true, schema: LISTING_SCHEMA },
      },
    });
  } catch (e) {
    const status = e && e.status;
    if (![400, 404, 415, 422, 501].includes(status)) throw e;
    // Retry: json_object mode + schema described in a trailing instruction.
    const hint = {
      role: "system",
      content:
        "Return ONLY a JSON object that conforms exactly to this JSON Schema (no markdown, no prose):\n" +
        JSON.stringify(LISTING_SCHEMA),
    };
    return await openai.chat.completions.create({
      ...base,
      messages: [...messages, hint],
      response_format: { type: "json_object" },
    });
  }
}

// Screenshots are sent as data-URL image_url parts alongside the text part in
// the same user message — but only for vision-capable models. Text-only models
// (gpt-oss) get the text prompt and the screenshots are skipped with a warning.
async function generateWithOpenAI(fields, files) {
  const usableFiles = modelSupportsVision(OPENAI_MODEL) ? files : [];
  const skippedImages = files.length - usableFiles.length;

  const content = [{ type: "text", text: buildPrompt(fields, usableFiles.length) }];
  for (const f of usableFiles) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${f.mimetype};base64,${f.buffer.toString("base64")}`,
        detail: "auto",
      },
    });
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content },
  ];

  const completion = await createCompletion(messages);
  const choice = completion.choices[0];
  if (choice.message.refusal) {
    throw new Error(`Model refused: ${choice.message.refusal}`);
  }
  if (choice.finish_reason === "length") {
    throw new Error("Model output was truncated (increase max_completion_tokens)");
  }
  return {
    listing: JSON.parse(choice.message.content),
    model: completion.model,
    skippedImages,
  };
}

// ---------------------------------------------------------------------------
// Offline fallback: deterministic template generation so the app works with
// no API key. Clearly labelled in the response.
// ---------------------------------------------------------------------------
const STOP_WORDS = new Set(
  "a an and are as at be by for from has have in is it its of on or that the this to was will with you your our we they them their what which when where who how why can app apps".split(" ")
);

function extractKeywords(fields) {
  const text = [fields.appName, fields.description, fields.features, fields.keywordsHint, fields.category]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const counts = new Map();
  for (const word of text.match(/[a-z][a-z0-9-]{2,}/g) || []) {
    if (STOP_WORDS.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([w]) => w);
}

function clip(str, max) {
  if (!str) return "";
  return str.length <= max ? str : str.slice(0, max - 1).trimEnd() + "…";
}

function generateWithTemplate(fields, files) {
  const name = fields.appName;
  const keywords = extractKeywords(fields);
  const features = (fields.features || "")
    .split(/\r?\n|,|;/)
    .map((s) => s.trim())
    .filter(Boolean);
  const featureBullets = features.length
    ? features.map((f) => `• ${f[0].toUpperCase()}${f.slice(1)}`).join("\n")
    : `• ${fields.description}`;
  const audience = fields.audience || "everyone";
  const tagline = clip(`${name} — ${fields.description}`, 80);
  const descClause = fields.description.replace(/\.\s*$/, "").replace(/^./, (c) => c.toLowerCase());

  const longDescription = [
    `${name} is built for ${audience} — it ${descClause}.`,
    "",
    "WHY YOU'LL LOVE IT",
    featureBullets,
    "",
    fields.pricing ? `Pricing: ${fields.pricing}.` : null,
    `Download ${name} today and see the difference for yourself.`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  const whatsNew =
    fields.whatsNew ||
    "• Performance improvements and bug fixes\n• Refreshed interface polish\n• Stability improvements";

  const appleKeywords = (() => {
    let out = "";
    for (const k of keywords) {
      const next = out ? `${out},${k}` : k;
      if (next.length > 100) break;
      out = next;
    }
    return out;
  })();

  const copyright = fields.copyright || `© ${CURRENT_YEAR} ${fields.companyName || name}`;
  const applePrimary = APPLE_CATEGORIES.includes(fields.category) ? fields.category : "Productivity";
  const appleSub = applePrimary === "Utilities" ? "Productivity" : "Utilities";
  const googlePrimary = GOOGLE_CATEGORIES.includes(fields.category) ? fields.category : "Productivity";
  const googleSub = googlePrimary === "Tools" ? "Productivity" : "Tools";

  return {
    appName: name,
    tagline,
    categorySuggestion: fields.category || "Productivity",
    appStore: {
      title: clip(name, 30),
      subtitle: clip(fields.description, 30),
      promotionalText: clip(`${fields.description} Try ${name} now!`, 170),
      description: clip(longDescription, 4000),
      keywords: appleKeywords,
      primaryCategory: applePrimary,
      subcategory: appleSub,
      ageRating: "4+",
      copyright,
      whatsNew,
    },
    googlePlay: {
      title: clip(name, 30),
      shortDescription: clip(fields.description, 80),
      fullDescription: clip(longDescription, 4000),
      keywords: keywords.slice(0, 12).join(", "),
      primaryCategory: googlePrimary,
      subcategory: googleSub,
      contentRating: "Everyone",
      copyright,
      whatsNew,
    },
    keywords,
    releaseNotes: whatsNew,
    faqs: [
      { question: `What is ${name}?`, answer: `${name} is an app that ${descClause}.` },
      { question: `Is ${name} free?`, answer: fields.pricing ? `${name} is ${fields.pricing}.` : `Check the store listing for current pricing details.` },
      { question: `Who is ${name} for?`, answer: `${name} is built for ${audience}.` },
      { question: "Which devices are supported?", answer: `${name} targets ${fields.platform || "both iOS and Android"} devices running a recent OS version.` },
      { question: "How do I get support?", answer: "Use the support link on the store listing or the in-app feedback option to reach the team." },
    ],
    privacy: {
      dataCollected: ["Usage data (analytics)", "Diagnostics (crash logs)"],
      privacyPolicySummary: `${name} collects only the minimum data required to operate and improve the app, such as anonymous usage analytics and crash diagnostics. Data is never sold to third parties. Users can request data deletion at any time via support.`,
      privacyNutritionLabel: ["Usage Data", "Diagnostics"],
    },
    privacyPolicy: [
      `${name} — Privacy Policy`,
      "",
      "Effective date: [effective date]",
      "",
      "Information We Collect",
      `${name} collects the minimum data needed to operate and improve the app, including anonymous usage analytics and crash diagnostics. We do not sell your personal data.`,
      "",
      "How We Use It",
      "We use collected data to provide core functionality, fix bugs, and improve the experience.",
      "",
      "Sharing",
      "We share data only with service providers who help us operate the app, or where required by law.",
      "",
      "Data Retention",
      "We retain data only as long as necessary for the purposes described here.",
      "",
      "Security",
      "We use reasonable technical and organizational measures to protect your data.",
      "",
      "Your Rights",
      "You may request access to or deletion of your data by contacting [contact email].",
      "",
      "Children's Privacy",
      `${name} is not directed to children under 13, and we do not knowingly collect their data.`,
      "",
      "Changes",
      "We may update this policy; material changes will be announced in the app or on our website.",
      "",
      "Contact",
      "Questions? Contact [Company Name] at [contact email]. Governing law: [jurisdiction].",
    ].join("\n"),
    termsOfService: [
      `${name} — Terms of Service`,
      "",
      "Effective date: [effective date]",
      "",
      "Acceptance",
      `By downloading or using ${name}, you agree to these Terms.`,
      "",
      "License to Use",
      `[Company Name] grants you a limited, non-exclusive, non-transferable license to use ${name} for personal, lawful purposes.`,
      "",
      "User Responsibilities",
      "You are responsible for your account, your content, and complying with applicable laws.",
      "",
      "Prohibited Conduct",
      "Do not misuse the app, attempt to disrupt it, reverse engineer it, or infringe others' rights.",
      "",
      "Intellectual Property",
      `${name} and its content are owned by [Company Name] and protected by applicable law.`,
      "",
      "Disclaimers",
      `${name} is provided "as is" without warranties of any kind.`,
      "",
      "Limitation of Liability",
      "To the maximum extent permitted by law, [Company Name] is not liable for indirect or consequential damages.",
      "",
      "Termination",
      "We may suspend or terminate access for violations of these Terms.",
      "",
      "Governing Law",
      "These Terms are governed by the laws of [jurisdiction].",
      "",
      "Changes",
      "We may update these Terms; continued use means acceptance of the updated Terms.",
      "",
      "Contact",
      "Contact [Company Name] at [contact email].",
    ].join("\n"),
    screenshotCaptions: files.map((_, i) => clip(features[i] || `${name} in action`, 60)),
    asoTips: [
      "Set OPENAI_API_KEY to unlock AI-written copy — this listing was produced by the offline template engine.",
      "Put your strongest keyword in the first 30 characters of the title.",
      "Use all available screenshot slots; the first two get the most views.",
      "Localize the listing for your top 5 markets to boost conversion.",
      "Refresh promotional text with every release — it can be updated without a new build.",
      "A/B test icons and screenshots via the store consoles' experiments tools.",
    ],
  };
}

// ---------------------------------------------------------------------------
// DOCX export — builds a Word document from the listing JSON, server-side.
// ---------------------------------------------------------------------------
function slugify(name) {
  return (
    (name || "app").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app"
  );
}

// Merge user-provided factual fields into the listing exactly as entered, so
// company/contact/URL data is never AI-generated or hallucinated. Also lets a
// user-supplied copyright override the generated one for both stores.
function applyPassthrough(listing, fields) {
  listing.companyName = fields.companyName || "";
  listing.submission = {
    companyName: fields.companyName || "",
    contactName: [fields.firstName, fields.lastName].filter(Boolean).join(" "),
    contactEmail: fields.contactEmail || "",
    phone: fields.phone || "",
    website: fields.website || "",
    supportUrl: fields.supportUrl || "",
    marketingUrl: fields.marketingUrl || "",
    privacyPolicyUrl: fields.privacyPolicyUrl || "",
  };
  if (fields.copyright) {
    if (listing.appStore) listing.appStore.copyright = fields.copyright;
    if (listing.googlePlay) listing.googlePlay.copyright = fields.copyright;
  }
  return listing;
}

function buildDocx(L) {
  const children = [];
  const heading = (text, level) => new Paragraph({ text, heading: level });
  // A labelled single-line field, e.g. "Title: NoteNest".
  const labelled = (name, value) =>
    new Paragraph({
      children: [new TextRun({ text: `${name}: `, bold: true }), new TextRun(value || "—")],
    });
  // A block of body text, split on newlines into one paragraph per line.
  const body = (text) =>
    String(text || "—")
      .split("\n")
      .map((line) => new Paragraph({ children: [new TextRun(line)] }));
  const bullets = (arr) =>
    (arr || []).map((item) => new Paragraph({ text: String(item), bullet: { level: 0 } }));

  children.push(new Paragraph({ text: `${L.appName} — Store Listing`, heading: HeadingLevel.TITLE }));
  if (L.companyName) children.push(labelled("Company", L.companyName));
  children.push(labelled("Tagline", L.tagline));

  const ios = L.appStore || {};
  children.push(heading("Apple App Store", HeadingLevel.HEADING_1));
  children.push(labelled("Name / Title", ios.title));
  children.push(labelled("Subtitle", ios.subtitle));
  children.push(labelled("Promotional text", ios.promotionalText));
  children.push(labelled("Keyword field", ios.keywords));
  children.push(labelled("Primary category", ios.primaryCategory));
  children.push(labelled("Subcategory", ios.subcategory));
  children.push(labelled("Age rating", ios.ageRating));
  children.push(labelled("Copyright", ios.copyright));
  children.push(heading("Description", HeadingLevel.HEADING_2));
  children.push(...body(ios.description));
  children.push(heading("What's new", HeadingLevel.HEADING_2));
  children.push(...body(ios.whatsNew));

  const play = L.googlePlay || {};
  children.push(heading("Google Play", HeadingLevel.HEADING_1));
  children.push(labelled("Title", play.title));
  children.push(labelled("Short description", play.shortDescription));
  children.push(labelled("Keywords", play.keywords));
  children.push(labelled("Primary category", play.primaryCategory));
  children.push(labelled("Subcategory", play.subcategory));
  children.push(labelled("Content rating", play.contentRating));
  children.push(labelled("Copyright", play.copyright));
  children.push(heading("Full description", HeadingLevel.HEADING_2));
  children.push(...body(play.fullDescription));
  children.push(heading("What's new", HeadingLevel.HEADING_2));
  children.push(...body(play.whatsNew));

  children.push(heading("ASO keywords", HeadingLevel.HEADING_1));
  children.push(new Paragraph({ children: [new TextRun((L.keywords || []).join(", ") || "—")] }));

  children.push(heading("Release notes", HeadingLevel.HEADING_1));
  children.push(...body(L.releaseNotes));

  children.push(heading("FAQs", HeadingLevel.HEADING_1));
  for (const f of L.faqs || []) {
    children.push(new Paragraph({ children: [new TextRun({ text: `Q: ${f.question}`, bold: true })] }));
    children.push(new Paragraph({ children: [new TextRun(`A: ${f.answer}`)] }));
  }

  const priv = L.privacy || {};
  children.push(heading("Privacy", HeadingLevel.HEADING_1));
  children.push(...body(priv.privacyPolicySummary));
  children.push(heading("Data likely collected", HeadingLevel.HEADING_2));
  children.push(...bullets(priv.dataCollected));
  children.push(heading("Apple privacy nutrition label", HeadingLevel.HEADING_2));
  children.push(...bullets(priv.privacyNutritionLabel));

  children.push(heading("Privacy Policy", HeadingLevel.HEADING_1));
  children.push(...body(L.privacyPolicy));

  children.push(heading("Terms of Service", HeadingLevel.HEADING_1));
  children.push(...body(L.termsOfService));

  if ((L.screenshotCaptions || []).length) {
    children.push(heading("Screenshot captions", HeadingLevel.HEADING_1));
    children.push(...bullets(L.screenshotCaptions));
  }

  children.push(heading("ASO tips", HeadingLevel.HEADING_1));
  children.push(...bullets(L.asoTips));

  const sub = L.submission || {};
  if (Object.values(sub).some(Boolean)) {
    children.push(heading("Submission details", HeadingLevel.HEADING_1));
    children.push(labelled("Company", sub.companyName));
    children.push(labelled("Contact name", sub.contactName));
    children.push(labelled("Contact email", sub.contactEmail));
    children.push(labelled("Phone", sub.phone));
    children.push(labelled("Website", sub.website));
    children.push(labelled("Support URL", sub.supportUrl));
    children.push(labelled("Marketing URL", sub.marketingUrl));
    children.push(labelled("Privacy Policy URL", sub.privacyPolicyUrl));
  }

  return new Document({ sections: [{ children }] });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    aiConfigured: Boolean(openai),
    provider: openai ? PROVIDER : null,
    model: openai ? OPENAI_MODEL : null,
    dbConfigured: DB_CONFIGURED,
    dbConnected: dbReady,
  });
});

// ---------------------------------------------------------------------------
// Mobile Application Portfolio — CRUD backed by MySQL
// ---------------------------------------------------------------------------
function requireDb(req, res, next) {
  if (!DB_CONFIGURED) {
    return res.status(503).json({
      error: "Portfolio database is not configured. Set the MYSQL_* values in .env and restart the server.",
    });
  }
  if (!dbReady) {
    return res.status(503).json({
      error: "Portfolio database is not connected. Check that MySQL is running and the MYSQL_* settings in .env are correct.",
    });
  }
  next();
}

// Turn a DB row into the JSON shape the frontend expects.
function rowToClient(r) {
  const parseArr = (v) => {
    if (Array.isArray(v)) return v; // JSON column already parsed
    if (typeof v === "string" && v.length) {
      try { return JSON.parse(v); } catch { return []; }
    }
    return [];
  };
  return {
    id: String(r.id),
    appName: r.appName,
    status: r.status,
    domain: r.domain,
    shortDescription: r.shortDescription,
    features: parseArr(r.features),
    techStack: parseArr(r.techStack),
    appStoreUrl: r.appStoreUrl,
    playStoreUrl: r.playStoreUrl,
    figmaUrl: r.figmaUrl,
    icon: r.icon || null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function normalizeBody(b) {
  const arr = (v) =>
    Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : [];
  return {
    appName: (b.appName || "").trim(),
    status: ["Live", "In Development", "POC"].includes(b.status) ? b.status : "Live",
    domain: (b.domain || "").trim(),
    shortDescription: (b.shortDescription || "").trim(),
    features: arr(b.features),
    techStack: arr(b.techStack),
    appStoreUrl: (b.appStoreUrl || "").trim(),
    playStoreUrl: (b.playStoreUrl || "").trim(),
    figmaUrl: (b.figmaUrl || "").trim(),
    icon: b.icon || null,
  };
}

// Positional values for an INSERT/UPDATE, in column order.
function toParams(d) {
  return [
    d.appName,
    d.status,
    d.domain,
    d.shortDescription,
    JSON.stringify(d.features),
    JSON.stringify(d.techStack),
    d.appStoreUrl,
    d.playStoreUrl,
    d.figmaUrl,
    d.icon,
  ];
}

// List apps, with optional ?search= &status= &domain= filters
app.get("/api/portfolio", requireDb, async (req, res) => {
  try {
    const { search, status, domain } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push("status = ?"); params.push(status); }
    if (domain) { where.push("domain = ?"); params.push(domain); }
    if (search) {
      where.push("(appName LIKE ? OR shortDescription LIKE ? OR domain LIKE ? OR techStack LIKE ? OR features LIKE ?)");
      const like = "%" + String(search) + "%";
      params.push(like, like, like, like, like);
    }
    const sql =
      "SELECT * FROM portfolio" +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY createdAt DESC, id DESC";
    const [rows] = await pool.query(sql, params);
    res.json({ apps: rows.map(rowToClient) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create
app.post("/api/portfolio", requireDb, async (req, res) => {
  try {
    const d = normalizeBody(req.body);
    if (!d.appName) return res.status(400).json({ error: "App name is required" });
    const [result] = await pool.query(
      `INSERT INTO portfolio
        (appName, status, domain, shortDescription, features, techStack, appStoreUrl, playStoreUrl, figmaUrl, icon)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      toParams(d)
    );
    const [rows] = await pool.query("SELECT * FROM portfolio WHERE id = ?", [result.insertId]);
    res.status(201).json({ app: rowToClient(rows[0]) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update
app.put("/api/portfolio/:id", requireDb, async (req, res) => {
  try {
    const d = normalizeBody(req.body);
    if (!d.appName) return res.status(400).json({ error: "App name is required" });
    const [result] = await pool.query(
      `UPDATE portfolio SET
        appName = ?, status = ?, domain = ?, shortDescription = ?, features = ?,
        techStack = ?, appStoreUrl = ?, playStoreUrl = ?, figmaUrl = ?, icon = ?
       WHERE id = ?`,
      [...toParams(d), req.params.id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: "App not found" });
    const [rows] = await pool.query("SELECT * FROM portfolio WHERE id = ?", [req.params.id]);
    res.json({ app: rowToClient(rows[0]) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete
app.delete("/api/portfolio/:id", requireDb, async (req, res) => {
  try {
    const [result] = await pool.query("DELETE FROM portfolio WHERE id = ?", [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: "App not found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/generate", (req, res) => {
  upload.array("screenshots", 6)(req, res, async (err) => {
    if (err) {
      const message =
        err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE"
          ? "Each screenshot must be 8 MB or smaller"
          : err.message;
      return res.status(400).json({ error: message });
    }

    const fields = {
      appName: (req.body.appName || "").trim(),
      companyName: (req.body.companyName || "").trim(),
      platform: (req.body.platform || "").trim(),
      category: (req.body.category || "").trim(),
      description: (req.body.description || "").trim(),
      features: (req.body.features || "").trim(),
      audience: (req.body.audience || "").trim(),
      pricing: (req.body.pricing || "").trim(),
      keywordsHint: (req.body.keywordsHint || "").trim(),
      whatsNew: (req.body.whatsNew || "").trim(),
      language: (req.body.language || "").trim(),
      copyright: (req.body.copyright || "").trim(),
      firstName: (req.body.firstName || "").trim(),
      lastName: (req.body.lastName || "").trim(),
      contactEmail: (req.body.contactEmail || "").trim(),
      phone: (req.body.phone || "").trim(),
      website: (req.body.website || "").trim(),
      supportUrl: (req.body.supportUrl || "").trim(),
      marketingUrl: (req.body.marketingUrl || "").trim(),
      privacyPolicyUrl: (req.body.privacyPolicyUrl || "").trim(),
    };

    if (!fields.appName || !fields.description) {
      return res.status(400).json({ error: "App name and description are required" });
    }

    const files = req.files || [];

    if (openai) {
      try {
        const { listing, model, skippedImages } = await generateWithOpenAI(fields, files);
        applyPassthrough(listing, fields);
        const warning =
          skippedImages > 0
            ? `${skippedImages} screenshot(s) were ignored because ${model || OPENAI_MODEL} is a text-only model. Use a vision model to include them.`
            : undefined;
        return res.json({ source: "ai", provider: PROVIDER, model, warning, listing });
      } catch (e) {
        console.error(`${PROVIDER} generation failed:`, e.message);
        let msg = e.message;
        if (e.status === 429 || e.status === 413) {
          msg = `${PROVIDER} rate/size limit hit (HTTP ${e.status}). On a free tier the per-minute token limit is low — wait a minute and retry, or lower OPENAI_MAX_TOKENS / upgrade your plan.`;
        }
        return res.json({
          source: "template",
          model: null,
          warning: `AI generation failed: ${msg} Showing offline template output instead.`,
          listing: applyPassthrough(generateWithTemplate(fields, files), fields),
        });
      }
    }

    return res.json({
      source: "template",
      model: null,
      warning: "OPENAI_API_KEY is not set — showing offline template output. Set the key and restart for AI-written copy.",
      listing: applyPassthrough(generateWithTemplate(fields, files), fields),
    });
  });
});

app.post("/api/export/docx", async (req, res) => {
  try {
    const listing = req.body && req.body.listing;
    if (!listing || !listing.appName) {
      return res.status(400).json({ error: "Missing listing data" });
    }
    const buffer = await Packer.toBuffer(buildDocx(listing));
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${slugify(listing.appName)}-listing.docx"`
    );
    return res.send(buffer);
  } catch (e) {
    console.error("DOCX export failed:", e.message);
    return res.status(500).json({ error: "Failed to generate the Word document" });
  }
});

const server = app.listen(PORT, () => {
  console.log(`✅ AI App Store Listing Generator running at http://localhost:${PORT}`);
  console.log(
    openai
      ? `   AI mode: ${PROVIDER} (${OPENAI_MODEL})${modelSupportsVision(OPENAI_MODEL) ? "" : " — text-only, screenshots ignored"}`
      : "   Offline mode: OPENAI_API_KEY not set (template fallback)"
  );
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ Port ${PORT} is already in use. Stop the other process or set a different PORT in .env.`);
    process.exit(1);
  }
  throw err;
});
