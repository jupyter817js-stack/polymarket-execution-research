const main = async (): Promise<void> => {
  console.log("start");
  const c = new AbortController();
  setTimeout(() => {
    console.log("aborting at", Date.now() - t0, "ms");
    c.abort();
  }, 8000);
  const t0 = Date.now();
  try {
    const r = await fetch(
      "https://gamma-api.polymarket.com/markets?closed=false&order=volume24hr&ascending=false&limit=200&offset=0",
      { signal: c.signal }
    );
    console.log("headers at", Date.now() - t0, "ms, status=", r.status);
    const d = await r.json();
    console.log("OK", Date.now() - t0, "ms, count=", Array.isArray(d) ? d.length : "?");
  } catch (e: unknown) {
    const err = e as Error;
    console.error("FAIL", Date.now() - t0, "ms,", err.name, err.message);
  }
};

main();
