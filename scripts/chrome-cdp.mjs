import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { config } from "./temu-config.mjs";

function cdpConfig(options = {}) {
  return {
    cdpPort: Number(options.cdpPort || config.cdpPort),
    cdpProfileDir: options.cdpProfileDir || config.cdpProfileDir,
    temuHomeUrl: options.temuHomeUrl || config.temuHomeUrl,
  };
}

export function cdpEndpointFor(options = {}) {
  return `http://127.0.0.1:${cdpConfig(options).cdpPort}`;
}

export const cdpEndpoint = cdpEndpointFor();

async function isCdpReady(options = {}) {
  try {
    const response = await fetch(`${cdpEndpointFor(options)}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(options = {}, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpReady(options)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Chrome CDP endpoint not ready: ${cdpEndpointFor(options)}`);
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

async function resetCdpChrome(options = {}) {
  const cdp = cdpConfig(options);
  const stdout = await execFileText("lsof", [
    "-tiTCP:" + String(cdp.cdpPort),
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

function chromeArgs(url, options = {}) {
  const cdp = cdpConfig(options);
  return [
    `--remote-debugging-port=${cdp.cdpPort}`,
    `--user-data-dir=${cdp.cdpProfileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
    "--window-size=1440,1000",
    url,
  ];
}

function launchWithOpen(url, options = {}) {
  spawn(
    "open",
    [
      "-na",
      "Google Chrome",
      "--args",
      ...chromeArgs(url, options),
    ],
    { detached: true, stdio: "ignore" },
  ).unref();
}

function launchWithChromeBinary(url, options = {}) {
  const chromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chromeExecutable)) return false;

  spawn(chromeExecutable, chromeArgs(url, options), { detached: true, stdio: "ignore" }).unref();
  return true;
}

export async function ensureCdpChrome(url = config.temuHomeUrl, options = {}) {
  if (await isCdpReady(options)) return;

  launchWithOpen(url, options);

  try {
    await waitForCdp(options);
  } catch (error) {
    if (!launchWithChromeBinary(url, options)) throw error;
    await waitForCdp(options, 20000);
  }
}

export async function connectCdpChrome(url = config.temuHomeUrl, options = {}) {
  await ensureCdpChrome(url, options);
  try {
    return await openCdpSession(options);
  } catch (error) {
    await resetCdpChrome(options);
    await ensureCdpChrome(url, options);
    return await openCdpSession(options);
  }
}

async function openCdpSession(options = {}) {
  const browser = await chromium.connectOverCDP(cdpEndpointFor(options));
  const context = browser.contexts()[0] || (await browser.newContext());
  const pages = context.pages();
  const page = pages[0] || (await context.newPage());
  return { browser, context, page };
}
