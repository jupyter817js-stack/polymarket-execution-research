import { config } from "../config.js";

const main = async (): Promise<void> => {
  console.log("gammaHost from config:", config.gammaHost);
  const url = new URL("/markets", config.gammaHost);
  url.searchParams.set("closed", "false");
  url.searchParams.set("order", "volume24hr");
  url.searchParams.set("ascending", "false");
  url.searchParams.set("limit", "200");
  url.searchParams.set("offset", "0");
  console.log("URL.toString():", url.toString());

  const c = new AbortController();
  setTimeout(() => {
    console.log("aborting at", Date.now() - t0, "ms");
    c.abort();
  }, 15000);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: c.signal });
    console.log("headers at", Date.now() - t0, "ms, status=", r.status);
    const d = await r.json();
    console.log("OK", Date.now() - t0, "ms, count=", Array.isArray(d) ? d.length : "?");
  } catch (e: unknown) {
    const err = e as Error;
    console.error("FAIL", Date.now() - t0, "ms,", err.name, err.message);
  }
};

main();
