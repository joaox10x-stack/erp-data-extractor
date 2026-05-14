process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const Tesseract = require("tesseract.js");

const DECLARATIONS_DIR = process.env.DECLARATIONS_DIR || "./output/declarations";
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!WEBHOOK_URL) {
  console.error("❌  WEBHOOK_URL is required. Set it in your .env file.");
  process.exit(1);
}

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  cyan: "\x1b[36m", white: "\x1b[37m", gray: "\x1b[90m",
};

function log(symbol, color, label, msg) {
  const ts = new Date().toLocaleTimeString("pt-BR");
  console.log(`${c.gray}${ts}${c.reset} ${color}${symbol}${c.reset} ${c.bold}${label}${c.reset} ${c.dim}|${c.reset} ${msg}`);
}
const ok   = (label, msg) => log("✔", c.green,  label, msg);
const warn = (label, msg) => log("!", c.yellow, label, msg);
const erro = (label, msg) => log("✘", c.red,    label, msg);
const info = (label, msg) => log("*", c.cyan,   label, msg);
const skip = (label, msg) => log("-", c.gray,   label, msg);

function header(text) {
  console.log(`\n${c.cyan}--- ${c.bold}${text}${c.reset}`);
}
function banner(total) {
  console.clear();
  console.log(`\n${c.bold}${c.cyan}`);
  console.log("  +==========================================+");
  console.log("  |   ERP PHONE EXTRACTOR  v3.0             |");
  console.log("  |   OCR  →  Parse  →  Webhook             |");
  console.log("  +==========================================+");
  console.log(`${c.reset}`);
  info("Start", `${c.white}${total} file(s) found${c.reset}`);
  console.log();
}
function printSummary(stats) {
  console.log(`\n${c.cyan}+--------------------------------------------+${c.reset}`);
  console.log(`${c.cyan}|${c.reset} ${c.bold}SUMMARY${c.reset}`);
  console.log(`${c.cyan}+--------------------------------------------+${c.reset}`);
  console.log(`  ${c.green}✔ Updated       ${String(stats.updated).padStart(3)}${c.reset}`);
  console.log(`  ${c.gray}- Skipped       ${String(stats.skipped).padStart(3)}${c.reset}`);
  console.log(`  ${c.yellow}! No phone      ${String(stats.noPhone).padStart(3)}${c.reset}`);
  console.log(`  ${c.red}✘ Errors        ${String(stats.errors).padStart(3)}${c.reset}`);
  console.log(`${c.cyan}+--------------------------------------------+${c.reset}\n`);
}

function normalizePhone(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, "");
  if (!digits) return null;
  digits = digits.replace(/^0+/, "");
  if (/^\d{10,11}$/.test(digits)) digits = "55" + digits;
  return digits;
}
function phoneValid(phone) {
  return /^55\d{10,11}$/.test(phone);
}
function extractPhonesFromText(text) {
  if (!text) return [];
  const candidates = new Set();
  const regexes = [
    /\+?55\s*\(?\d{2}\)?\s*9?\d{4}[-.\s]?\d{4}/g,
    /\(?\d{2}\)?\s*9?\d{4}[-.\s]?\d{4}/g,
    /\d{2}\s*9\d{4}[-.\s]?\d{4}/g,
  ];
  for (const regex of regexes) {
    const matches = text.match(regex) || [];
    for (const m of matches) {
      const tel = normalizePhone(m);
      if (tel) candidates.add(tel);
    }
  }
  return [...candidates].filter(phoneValid);
}
function extractBestPhone(text) {
  const phones = extractPhonesFromText(text);
  if (!phones.length) return null;
  const mobile = phones.find((t) => t[4] === "9");
  return mobile || phones[0];
}

function extractRecordIdFromFilename(filename) {
  const base = path.parse(filename).name;
  const match = base.match(/_(\d+)_DECLARATION$/i);
  if (match && match[1]) return match[1];
  const parts = base.split("_");
  if (parts.length >= 2) return parts[parts.length - 2];
  throw new Error(`Cannot extract record ID from filename: ${filename}`);
}

async function extractPhoneWithOCR(imagePath) {
  const result = await Tesseract.recognize(imagePath, "por", { logger: () => {} });
  const text = result?.data?.text || "";
  const phone = extractBestPhone(text);
  return { phone, text };
}

async function sendToWebhook(recordId, phone) {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recordId, phone }),
  });
  return await res.json();
}

async function processFile(filePath, stats) {
  const filename = path.basename(filePath);
  const recordId = extractRecordIdFromFilename(filename);
  header(`Record ${recordId}  |  ${filename}`);
  info("OCR", "Reading image...");
  const ocr = await extractPhoneWithOCR(filePath);
  if (!ocr.phone) {
    warn("OCR", "No phone number found in image");
    stats.noPhone++;
    return false;
  }
  ok("OCR", `Phone detected → ${c.green}${c.bold}${ocr.phone}${c.reset}`);
  info("Webhook", "Sending to webhook...");
  const result = await sendToWebhook(recordId, ocr.phone);
  if (result.error) {
    warn("Webhook", `${c.yellow}${result.message || "Error response"}${c.reset}`);
    stats.skipped++;
  } else {
    ok("Webhook", `Updated: ${c.green}${result.updated ?? 0}${c.reset}  Skipped: ${c.gray}${result.skipped ?? 0}${c.reset}`);
    stats.updated += result.updated ?? 0;
    stats.skipped += result.skipped ?? 0;
  }
  fs.unlinkSync(filePath);
  skip("File", "Deleted after processing");
  return !result.error;
}

async function main() {
  if (!fs.existsSync(DECLARATIONS_DIR)) {
    console.log(`\n${c.red}✘ Directory not found: ${DECLARATIONS_DIR}${c.reset}\n`);
    process.exit(1);
  }
  const files = fs.readdirSync(DECLARATIONS_DIR)
    .map((name) => path.join(DECLARATIONS_DIR, name))
    .filter((f) => [".jpg", ".jpeg", ".png"].includes(path.extname(f).toLowerCase()));
  if (!files.length) {
    console.log(`\n${c.red}✘ No image files found in ${DECLARATIONS_DIR}${c.reset}\n`);
    return;
  }
  banner(files.length);
  const stats = { updated: 0, skipped: 0, noPhone: 0, errors: 0 };
  for (const filePath of files) {
    try { await processFile(filePath, stats); }
    catch (e) { erro("Error", e.message); stats.errors++; }
  }
  printSummary(stats);
}

main();
