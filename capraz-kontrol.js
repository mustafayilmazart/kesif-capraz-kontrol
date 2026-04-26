#!/usr/bin/env node
/**
 * CaprazKontrol - Çapraz AI Kod Review Sistemi
 * Claude Code + Gemini CLI + Codex CLI + Qwen CLI
 */

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ─── Renkler ────────────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  dim: "\x1b[2m",
};

function log(color, prefix, msg) {
  console.log(`${color}${C.bold}[${prefix}]${C.reset} ${msg}`);
}

// ─── Config ──────────────────────────────────────────────────────────────────
const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

// ─── .env Yükleyici ──────────────────────────────────────────────────────────
// API key'leri .env dosyasından oku ve process.env'e yükle
// Default: bu script'in bulunduğu dizindeki .env (taşınabilir)
const ENV_FILE = config.envFile || path.join(__dirname, ".env");
function _loadEnv() {
  try {
    const lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
    for (const line of lines) {
      // KEY=VALUE veya KEY = VALUE formatını destekle
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch (_) { /* .env yoksa sessizce geç */ }
}
_loadEnv();

// ─── Prompt ──────────────────────────────────────────────────────────────────
const REVIEW_PROMPT = `Aşağıdaki kodu uzman bir yazılım geliştirici olarak incele ve Türkçe raporla:

1. **KOD KALİTESİ**: Temizlik, okunabilirlik, best practice
2. **HATALAR / BUG'LAR**: Potansiyel hatalar, edge case'ler
3. **GÜVENLİK**: Güvenlik açıkları
4. **PERFORMANS**: İyileştirme fırsatları
5. **ÖNERİLER**: Somut düzeltme önerileri

Kısa ve öz tut. Her madde için kritiklik seviyesi belirt: 🔴 Kritik | 🟡 Orta | 🟢 Düşük`;

// ─── AI Runner'lar ────────────────────────────────────────────────────────────
// Prompt'u stdin üzerinden CLI'ya gönderen ortak yardımcı
// ─── Argüman array'iyle güvenli komut çalıştırma ─────────────────────────────
// Shell yerine doğrudan exec → command injection yüzeyi sıfırlanır.
// Per-CLI key whitelist → cross-provider key leak engellenir.

const PROVIDER_KEYS = {
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  codex: ["OPENAI_API_KEY"],
  qwen: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"],
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
};

function _filteredEnv(provider) {
  // Sadece provider'ın ihtiyaç duyduğu key'i geçir + temel sistem değişkenleri
  const allowed = new Set([
    "PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA",
    "SYSTEMROOT", "PATHEXT", "COMSPEC", "WINDIR", "USERNAME",
    ...(PROVIDER_KEYS[provider] || []),
  ]);
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (allowed.has(k)) env[k] = process.env[k];
  }
  return env;
}

function _runViaStdin(cmd, args, prompt, provider) {
  // cmd: string (executable adı), args: string[] (argümanlar)
  const result = spawnSync(cmd, args, {
    input: prompt,
    encoding: "utf8",
    timeout: config.timeoutMs,
    env: _filteredEnv(provider),
    shell: false,  // KRİTİK: shell yok → meta-karakter injection yok
  });
  if (result.error) throw result.error;
  return result.stdout || result.stderr || "Yanıt alınamadı.";
}

function runGemini(filePath) {
  try {
    const code = fs.readFileSync(filePath, "utf8");
    const prompt = `${REVIEW_PROMPT}\n\n\`\`\`\n${code}\n\`\`\``;
    return _runViaStdin("gemini", ["-p", "-", "--yolo", "--output-format", "text"], prompt, "gemini");
  } catch (err) {
    return `HATA: ${err.message}`;
  }
}

function runCodex(filePath) {
  try {
    const code = fs.readFileSync(filePath, "utf8");
    const prompt = `${REVIEW_PROMPT}\n\n\`\`\`\n${code}\n\`\`\``;
    return _runViaStdin("codex", ["exec", "--skip-git-repo-check", "-"], prompt, "codex");
  } catch (err) {
    return `HATA: ${err.message}`;
  }
}

function runQwen(filePath) {
  try {
    const code = fs.readFileSync(filePath, "utf8");
    const prompt = `${REVIEW_PROMPT}\n\n\`\`\`\n${code}\n\`\`\``;
    const cmd = config.qwenCommand || "llxprt";
    const model = config.qwenModel || "qwen2.5-coder-32b";
    return _runViaStdin(cmd, ["--provider", "openai", "--model", model, "-p", "-", "--output-format", "text"], prompt, "qwen");
  } catch (err) {
    return `HATA: ${err.message}`;
  }
}

function runClaude(filePath) {
  try {
    const code = fs.readFileSync(filePath, "utf8");
    const prompt = `${REVIEW_PROMPT}\n\n\`\`\`\n${code}\n\`\`\``;
    const claudeCmd = config.claudeCommand || "claude";
    const claudeArgs = Array.isArray(config.claudeArgs) ? config.claudeArgs : ["--print"];
    return _runViaStdin(claudeCmd, [...claudeArgs, "-"], prompt, "claude");
  } catch (err) {
    return `HATA: ${err.message}`;
  }
}

// ─── Rapor Üretici ────────────────────────────────────────────────────────────
function generateReport(filePath, results) {
  const now = new Date();
  const dateStr = now.toLocaleString("tr-TR");
  const fileName = path.basename(filePath);
  const reportName = `rapor_${fileName}_${now.getTime()}.md`;
  const reportPath = path.join(__dirname, "raporlar", reportName);

  fs.mkdirSync(path.join(__dirname, "raporlar"), { recursive: true });

  let md = `# 🔍 Çapraz AI Kod Review Raporu\n\n`;
  md += `**Dosya:** \`${filePath}\`  \n`;
  md += `**Tarih:** ${dateStr}  \n`;
  md += `**Aktif AI'lar:** ${results.map((r) => r.name).join(", ")}\n\n`;
  md += `---\n\n`;

  for (const r of results) {
    md += `## ${r.icon} ${r.name}\n\n`;
    if (r.skipped) {
      md += `> ⏭️ Bu AI devre dışı (config.json'da aktif değil)\n\n`;
    } else if (r.response.startsWith("HATA:")) {
      md += `> ❌ ${r.response}\n\n`;
    } else {
      md += `${r.response}\n\n`;
    }
    md += `---\n\n`;
  }

  md += `## 📊 Özet\n\n`;
  md += `| AI | Durum |\n|---|---|\n`;
  for (const r of results) {
    const status = r.skipped ? "⏭️ Atlandı" : r.response.startsWith("HATA:") ? "❌ Hata" : "✅ Tamamlandı";
    md += `| ${r.icon} ${r.name} | ${status} |\n`;
  }

  fs.writeFileSync(reportPath, md, "utf8");
  return reportPath;
}

// ─── Ana Fonksiyon ────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`\n${C.cyan}${C.bold}╔══════════════════════════════════════╗`);
    console.log(`║     CaprazKontrol v1.0               ║`);
    console.log(`║     Çapraz AI Kod Review Sistemi     ║`);
    console.log(`╚══════════════════════════════════════╝${C.reset}\n`);
    console.log(`${C.yellow}Kullanım:${C.reset}`);
    console.log(`  node capraz-kontrol.js <dosya_yolu>`);
    console.log(`  node capraz-kontrol.js src/app.js\n`);
    console.log(`${C.dim}Aktif AI'lar: config.json'dan yönet${C.reset}\n`);
    process.exit(0);
  }

  const filePath = path.resolve(args[0]);

  if (!fs.existsSync(filePath)) {
    log(C.red, "HATA", `Dosya bulunamadı: ${filePath}`);
    process.exit(1);
  }

  console.log(`\n${C.cyan}${C.bold}╔══════════════════════════════════════╗`);
  console.log(`║     CaprazKontrol - Review Başlıyor  ║`);
  console.log(`╚══════════════════════════════════════╝${C.reset}`);
  console.log(`${C.dim}Dosya: ${filePath}${C.reset}\n`);

  const results = [];
  const aiList = [
    {
      key: "gemini",
      name: "Gemini CLI",
      icon: "🟦",
      runner: runGemini,
      color: C.blue,
    },
    {
      key: "codex",
      name: "Codex CLI",
      icon: "🟩",
      runner: runCodex,
      color: C.green,
    },
    {
      key: "qwen",
      name: "Qwen CLI",
      icon: "🟧",
      runner: runQwen,
      color: C.yellow,
    },
    {
      key: "claude",
      name: "Claude Code",
      icon: "🟪",
      runner: runClaude,
      color: C.magenta,
    },
  ];

  for (const ai of aiList) {
    if (!config.aktifAIlar[ai.key]) {
      log(C.dim, ai.name, "Atlandı (config'de devre dışı)");
      results.push({ ...ai, skipped: true, response: "" });
      continue;
    }

    log(ai.color, ai.name, "Review başlatılıyor...");
    const start = Date.now();
    const response = ai.runner(filePath);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (response.startsWith("HATA:")) {
      log(C.red, ai.name, `❌ ${response} (${elapsed}s)`);
    } else {
      log(ai.color, ai.name, `✅ Tamamlandı (${elapsed}s)`);
    }

    results.push({ ...ai, response });
  }

  // Raporu kaydet (Markdown)
  const reportPath = generateReport(filePath, results);
  log(C.magenta, "RAPOR", `Kaydedildi: ${reportPath}`);

  // JSON rapor (content-dashboard için)
  if (config.jsonOutput) {
    const jsonDir = path.join(__dirname, config.jsonOutputDir || "raporlar/json");
    fs.mkdirSync(jsonDir, { recursive: true });
    const jsonName = `review_${path.basename(filePath)}_${Date.now()}.json`;
    const jsonPath = path.join(jsonDir, jsonName);
    const jsonReport = {
      file: filePath,
      timestamp: new Date().toISOString(),
      reviews: results.map((r) => ({
        ai: r.name,
        icon: r.icon,
        skipped: !!r.skipped,
        error: r.response?.startsWith("HATA:") || false,
        response: r.response?.slice(0, 5000) || "",
      })),
      summary: {
        total: results.length,
        completed: results.filter((r) => !r.skipped && !r.response?.startsWith("HATA:")).length,
        skipped: results.filter((r) => r.skipped).length,
        errors: results.filter((r) => r.response?.startsWith("HATA:")).length,
      },
    };
    fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), "utf8");
    log(C.cyan, "JSON", `Kaydedildi: ${jsonPath}`);
  }

  // Konsola özet bas
  console.log(`\n${C.cyan}${C.bold}═══════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}REVIEW ÖZET${C.reset}`);
  console.log(`${C.cyan}═══════════════════════════════════════${C.reset}\n`);

  for (const r of results) {
    if (r.skipped || r.response.startsWith("HATA:")) continue;
    console.log(`${r.icon} ${C.bold}${r.name}${C.reset}`);
    console.log(`${C.dim}${r.response.slice(0, 400)}...${C.reset}\n`);
  }

  console.log(`\n${C.green}✅ Tam rapor: ${reportPath}${C.reset}\n`);
}

main().catch((err) => {
  log(C.red, "KRITIK HATA", err.message);
  process.exit(1);
});
