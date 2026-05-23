import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { config } from "./temu-config.mjs";

export const cdpEndpoint = `http://127.0.0.1:${config.cdpPort}`;

async function isCdpReady() {
  try {
    const response = await fetch(`${cdpEndpoint}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Chrome CDP endpoint not ready: ${cdpEndpoint}`);
}

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        if (error.code === 1) {
          resolve("");
          return;
        }
        reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function resetCdpChrome() {
  const stdout = await execFileText("lsof", [
    "-tiTCP:" + String(config.cdpPort),
    "-sTCP:LISTEN",
  ]);
  const pids = stdout
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value));

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have exited between lsof and kill.
    }
  }

  if (pids.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

function chromeArgs(url) {
  return [
    `--remote-debugging-port=${config.cdpPort}`,
    `--user-data-dir=${config.cdpProfileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    url,
  ];
}

function launchWithOpen(url) {
  spawn(
    "open",
    [
      "-na",
      "Google Chrome",
      "--args",
      ...chromeArgs(url),
    ],
    { detached: true, stdio: "ignore" },
  ).unref();
}

function launchWithChromeBinary(url) {
  const chromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chromeExecutable)) return false;

  spawn(chromeExecutable, chromeArgs(url), { detached: true, stdio: "ignore" }).unref();
  return true;
}

export async function ensureCdpChrome(url = config.temuHomeUrl) {
  if (await isCdpReady()) return;

  launchWithOpen(url);

  try {
    await waitForCdp();
  } catch (error) {
    if (!launchWithChromeBinary(url)) throw error;
    await waitForCdp(20000);
  }
}

export async function connectCdpChrome(url = config.temuHomeUrl) {
  await ensureCdpChrome(url);
  try {
    return await openCdpSession();
  } catch (error) {
    await resetCdpChrome();
    await ensureCdpChrome(url);
    return await openCdpSession();
  }
}

async function openCdpSession() {
  const browser = await chromium.connectOverCDP(cdpEndpoint);
  const context = browser.contexts()[0] || (await browser.newContext());
  const pages = context.pages();
  const page = pages[0] || (await context.newPage());
  return { browser, context, page };
}
