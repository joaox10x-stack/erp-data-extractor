import fs from "fs";
import path from "path";
import { chromium } from "playwright";

function env(name) {
  return (process.env[name] || "").trim();
}
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function formatBR(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}
function tomorrowLocal() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(12, 0, 0, 0);
  return d;
}
function normName(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}
function safeFilePart(s) {
  return (
    normName(s).replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "SEM_NOME"
  );
}
async function screenshotLocator(locator, outPath) {
  ensureDir(path.dirname(outPath));
  await locator.screenshot({ path: outPath }).catch(async () => {
    const page = locator.page();
    await page.screenshot({ path: outPath, fullPage: true });
  });
}
async function capture(page, outDir, tag) {
  ensureDir(outDir);
  fs.writeFileSync(path.join(outDir, `${tag}.html`), await page.content(), "utf-8");
  await page.screenshot({ path: path.join(outDir, `${tag}.png`), fullPage: true });
}
async function login(page, outDir) {
  const baseUrl = env("ERP_BASE_URL");
  const user = env("ERP_USER");
  const pass = env("ERP_PASS");
  if (!baseUrl || !user || !pass) throw new Error("Defina ERP_BASE_URL, ERP_USER e ERP_PASS no .env");
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  const userBox = page.getByRole("textbox", { name: /usu[aá]rio/i });
  const passBox = page.getByRole("textbox", { name: /senha/i });
  if (!(await userBox.count()) || !(await passBox.count())) {
    await capture(page, outDir, "login_missing_fields");
    throw new Error("Campos de login não encontrados.");
  }
  await userBox.fill(user);
  await passBox.fill(pass);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForTimeout(1200);
  const prosseguir = page.getByRole("button", { name: /prosseguir/i }).first();
  try {
    await prosseguir.waitFor({ state: "visible", timeout: 15000 });
    await prosseguir.click({ timeout: 15000 });
    await page.waitForTimeout(1200);
  } catch {}
  await page.waitForURL(/\/home/i, { timeout: 60000 });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle").catch(() => {});
}
async function openTargetModule(page, outDir) {
  const moduleName = env("ERP_MODULE") || "Gestão de Montagem";
  const searchBox = page.getByPlaceholder("Pesquisa...").first()
    .or(page.locator('input[placeholder*="Pesquisa" i]').first())
    .or(page.getByRole("textbox", { name: /pesquisa/i }).first());
  await searchBox.waitFor({ state: "visible", timeout: 60000 });
  try { await searchBox.click({ timeout: 15000 }); }
  catch { await searchBox.click({ timeout: 15000, force: true }); }
  await searchBox.fill(moduleName.split(" ").slice(0, 2).join(" ").toLowerCase());
  await page.getByText(moduleName, { exact: false }).click();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1200);
  const hasFilter = await page.getByRole("button", { name: /filtrar/i }).count();
  if (!hasFilter) { await capture(page, outDir, "module_not_loaded"); throw new Error(`Módulo "${moduleName}" não carregou.`); }
}
async function applyDateFilter(page, outDir, recordType = "3") {
  const d = tomorrowLocal();
  const dataStr = formatBR(d);
  const dia = String(d.getDate());
  await page.getByLabel("Filial da Entrega/Montagem").selectOption("").catch(() => {});
  await page.getByLabel("Tipo de Montagem").selectOption(recordType).catch(() => {});
  const iniInput = page.locator("#campo_previsao_montagem_inicial input").first();
  const fimInput = page.locator("#campo_previsao_montagem_final input").first();
  let filled = false;
  try {
    if ((await iniInput.isVisible({ timeout: 1200 })) && (await fimInput.isVisible({ timeout: 1200 }))) {
      await iniInput.fill(dataStr); await fimInput.fill(dataStr); filled = true;
    }
  } catch {}
  if (!filled) {
    await page.locator(".input-group-addon").first().click();
    await page.getByRole("cell", { name: dia, exact: true }).click();
    await page.locator("#campo_previsao_montagem_final > div > .input-group > .input-group-addon > .glyphicon").click();
    await page.getByRole("cell", { name: dia, exact: true }).click();
  }
  await page.getByRole("button", { name: /filtrar/i }).first().click();
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1200);
  await capture(page, outDir, `after_filter_type${recordType}`);
}
async function closeEditModal(page) {
  const modal = page.locator("#modal_edicao_montagem");
  if (await modal.count()) {
    const visible = await modal.isVisible().catch(() => false);
    if (visible) {
      const closeBtn = modal.getByRole("button", { name: /fechar|cancelar/i }).first();
      if (await closeBtn.count()) await closeBtn.click().catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      await modal.waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
    }
  }
}
async function extractAssigneesFromModal(modal, page) {
  const clean = (s) => String(s || "").replace(/\s+/g, " ").replace(/^Selecionar:?/i, "").trim();
  const splitNames = (text) => clean(text).split(/\s*,\s*|\s+e\s+|\n+/i).map((x) => clean(x)).filter((x) => x && !/nenhum registro|selecione|selecionar/i.test(x));
  const uniqByNorm = (arr) => { const out = []; const seen = new Set(); for (const v of arr) { const k = normName(v); if (!k) continue; if (!seen.has(k)) { seen.add(k); out.push(v); } } return out; };
  const fieldRoot = modal.locator('label:has-text("Montadores")').locator("xpath=ancestor::*[contains(@class,'form-group')][1]").first().or(modal.locator('label:has-text("Montadores")').locator("xpath=..").first()).or(modal);
  const bsBtn = fieldRoot.locator(".bootstrap-select button").first().or(modal.locator('label:has-text("Montadores")').locator("xpath=following::button[1]").first());
  if (await bsBtn.count()) { const txt = clean(await bsBtn.innerText().catch(() => "")); const byBtn = splitNames(txt); if (byBtn.length) return uniqByNorm(byBtn); }
  const sel = fieldRoot.locator("select").first().or(modal.locator('label:has-text("Montadores")').locator("xpath=following::select[1]").first());
  if (await sel.count()) { const selected = await sel.locator("option:checked").allInnerTexts().catch(() => []); const byOption = uniqByNorm(selected.map(clean).filter(Boolean)); if (byOption.length) return byOption; }
  if (await bsBtn.count()) {
    await bsBtn.click().catch(async () => await bsBtn.click({ force: true }));
    await page.waitForTimeout(250);
    const lis = modal.locator(".bootstrap-select .dropdown-menu li.selected, .bootstrap-select .dropdown-menu li.active");
    const n = await lis.count(); const found = [];
    for (let i = 0; i < n; i++) { const t = clean(await lis.nth(i).innerText().catch(() => "")); if (t) found.push(t); }
    await page.keyboard.press("Escape").catch(() => {}); await page.waitForTimeout(150);
    const byLi = uniqByNorm(found); if (byLi.length) return byLi;
  }
  return [];
}
async function screenshotDeclaration(page, outDir, fileBase, via = 1) {
  const declDir = path.join(outDir, "declarations");
  ensureDir(declDir);
  const btn = page.getByRole("button", { name: new RegExp(`Imprimir Declaração \\(${via}ª via\\)`, "i") }).first().or(page.getByRole("button", { name: /Imprimir Declaração/i }).first());
  if (!(await btn.count())) return { ok: false, reason: "Print Declaration button not found" };
  const popupPromise = page.waitForEvent("popup", { timeout: 60000 });
  await btn.click().catch(async () => await btn.click({ force: true }));
  const popup = await popupPromise;
  await popup.bringToFront().catch(() => {});
  await popup.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
  await popup.waitForLoadState("domcontentloaded").catch(() => {});
  await popup.waitForLoadState("networkidle").catch(() => {});
  await popup.waitForTimeout(1500);
  const outPng = path.join(declDir, `${fileBase}_DECLARATION.png`);
  try {
    const pdfEmbed = popup.locator('embed[type="application/pdf"]').first();
    const pdfObject = popup.locator('object[type="application/pdf"]').first();
    const iframe = popup.locator("iframe").first();
    if (await pdfEmbed.count()) await pdfEmbed.waitFor({ state: "visible", timeout: 45000 });
    else if (await pdfObject.count()) await pdfObject.waitFor({ state: "visible", timeout: 45000 });
    else if (await iframe.count()) await iframe.waitFor({ state: "visible", timeout: 45000 });
    const clip = { x: Number(env("DECL_CLIP_X") || 640), y: Number(env("DECL_CLIP_Y") || 110), width: Number(env("DECL_CLIP_W") || 760), height: Number(env("DECL_CLIP_H") || 980) };
    await popup.screenshot({ path: outPng, clip });
  } catch (e) {
    await popup.screenshot({ path: outPng, fullPage: true }).catch(() => {});
    await popup.close().catch(() => {});
    return { ok: false, reason: `Error capturing declaration: ${String(e)}`, outPng };
  }
  await popup.close().catch(() => {});
  return { ok: true, outPng };
}
async function goToNextPage(page) {
  const nextLi = page.locator("ul.pagination li").filter({ hasText: /^>$/ }).first();
  if (!(await nextLi.count())) return false;
  const isDisabled = await nextLi.evaluate((li) => li.classList.contains("disabled")).catch(() => true);
  if (isDisabled) return false;
  await nextLi.locator("a").click();
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1000);
  return true;
}
async function collectRecords(page, outDir, recordType, limit = 90) {
  const via = Number(env("VIA") || "1");
  const tasks = [];
  const dateTag = formatBR(tomorrowLocal()).replaceAll("/", "-");
  const printsDir = path.join(outDir, "prints");
  ensureDir(printsDir);
  let pageNum = 1; let globalIdx = 0;
  while (true) {
    console.log(`  📄 Page ${pageNum}...`);
    const rows = page.locator("table tbody tr");
    const count = await rows.count();
    if (count === 0) { await capture(page, outDir, `no_rows_type${recordType}_pg${pageNum}`); break; }
    const n = Math.min(count, limit - tasks.length);
    for (let i = 0; i < n; i++) {
      globalIdx++;
      const row = rows.nth(i);
      try {
        let cellText = "";
        const cellPen = row.getByRole("cell", { name: /✏/ }).first();
        if (await cellPen.count()) { cellText = await cellPen.innerText().catch(() => ""); await cellPen.click(); }
        else { await row.click(); }
        const modal = page.locator("#modal_edicao_montagem");
        await modal.waitFor({ state: "visible", timeout: 30000 });
        const assignees = await extractAssigneesFromModal(modal, page);
        const pick = async (labelRegex) => { const loc = modal.getByLabel(labelRegex); if (await loc.count()) { const v = await loc.inputValue().catch(async () => await loc.textContent().catch(() => "")); return String(v || "").trim(); } return ""; };
        const reference = await pick(/N[ºo]\s*Lançamento|Lançamento/i);
        const order = await pick(/Pedido/i);
        const client = (await pick(/Cliente/i)) || cellText.replace("✏", "").trim();
        const idBase = safeFilePart(reference || order || client || `record_${globalIdx}`);
        const fileBase = `${dateTag}_T${recordType}_${String(globalIdx).padStart(2, "0")}_${idBase}`;
        const modalPrintPath = path.join(printsDir, `${fileBase}.png`);
        await page.waitForTimeout(200);
        await screenshotLocator(modal, modalPrintPath);
        await page.waitForTimeout(300);
        const decl = await screenshotDeclaration(page, outDir, fileBase, via);
        tasks.push({ idx: globalIdx, page: pageNum, recordType, client, reference: reference || order || "", assignees, modalPrintPath, declarationPath: decl?.ok ? decl.outPng : "", declarationOk: !!decl?.ok, declarationError: decl?.ok ? "" : (decl?.reason || "") });
        await closeEditModal(page);
        await page.waitForTimeout(250);
      } catch (e) {
        await capture(page, outDir, `record_type${recordType}_pg${pageNum}_${i + 1}_error`);
        await closeEditModal(page);
        tasks.push({ idx: globalIdx, page: pageNum, recordType, error: String(e), assignees: [] });
      }
    }
    if (tasks.length >= limit) break;
    const hasNext = await goToNextPage(page);
    if (!hasNext) break;
    pageNum++;
  }
  return tasks;
}
(async () => {
  const outDir = env("OUT_DIR") || "./output";
  const limit = Number(env("LIMIT") || "200");
  const headless = env("HEADLESS") === "1";
  const slowMo = Number(env("SLOWMO") || (headless ? "0" : "200"));
  const typesRaw = env("RECORD_TYPES") || "3,5";
  const types = typesRaw.split(",").map((t) => t.trim()).filter(Boolean);
  ensureDir(outDir);
  const browser = await chromium.launch({ headless, slowMo });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 768 }, acceptDownloads: false });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  let allRecords = [];
  try {
    await login(page, outDir);
    await openTargetModule(page, outDir);
    for (const type of types) {
      console.log(`\n🔍 Processing record type: ${type}`);
      await applyDateFilter(page, outDir, type);
      const records = await collectRecords(page, outDir, type, limit);
      allRecords = allRecords.concat(records);
      console.log(`✅ Type ${type}: ${records.length} record(s) processed`);
    }
    fs.writeFileSync(path.join(outDir, "records.json"), JSON.stringify(allRecords, null, 2), "utf-8");
    console.log(`\n✅ Total: ${allRecords.length} record(s)`);
    console.log(`   Modal prints  : ${path.join(outDir, "prints")}`);
    console.log(`   Declarations  : ${path.join(outDir, "declarations")}`);
    console.log(`   records.json  : ${path.join(outDir, "records.json")}`);
  } catch (e) {
    console.error("❌ Fatal error:", e);
    await capture(page, outDir, "fatal");
    await browser.close();
    process.exit(1);
  }
  await browser.close();
})();
