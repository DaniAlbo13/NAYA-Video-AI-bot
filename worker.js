const DEFAULT_ORIGIN = "*";

function json(data, status = 200, origin = DEFAULT_ORIGIN) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "Content-Type",
      "cache-control": "no-store"
    }
  });
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gains += change; else losses -= change;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  const tail = trs.slice(-period);
  return tail.reduce((a, b) => a + b, 0) / tail.length;
}

function round(n, digits = 4) {
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
}

function analyze(symbol, interval, candles) {
  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];
  const fast = ema(closes, 9), slow = ema(closes, 21);
  const momentum = rsi(closes, 14), volatility = atr(candles, 14);
  if ([fast, slow, momentum, volatility].some(v => v === null) || volatility <= 0) {
    return { symbol, interval, signal: "WAIT", reason: "داده کافی برای تحلیل وجود ندارد.", candleCount: candles.length };
  }

  const up = fast > slow && last.close > slow && momentum >= 52 && momentum < 72;
  const down = fast < slow && last.close < slow && momentum <= 48 && momentum > 28;
  let signal = "WAIT", reason = "شرایط روند و مومنتوم هم‌جهت نیستند؛ برای کاهش سیگنال‌های ضعیف صبر کن.";
  if (up) { signal = "BUY"; reason = "EMA 9 بالاتر از EMA 21 است، قیمت بالای EMA 21 قرار دارد و RSI مومنتوم صعودی را تأیید می‌کند."; }
  if (down) { signal = "SELL"; reason = "EMA 9 پایین‌تر از EMA 21 است، قیمت زیر EMA 21 قرار دارد و RSI مومنتوم نزولی را تأیید می‌کند."; }

  const entry = last.close;
  const stopDistance = volatility * 1.5;
  const direction = signal === "BUY" ? 1 : signal === "SELL" ? -1 : 0;
  const stop = direction ? entry - direction * stopDistance : null;
  const target1 = direction ? entry + direction * stopDistance * 1.5 : null;
  const target2 = direction ? entry + direction * stopDistance * 2.2 : null;
  return {
    symbol, interval, signal, reason,
    updatedAt: new Date(last.time).toISOString(),
    price: round(entry, 8),
    entryZone: direction ? [round(entry - volatility * 0.15, 8), round(entry + volatility * 0.15, 8)] : null,
    stopLoss: stop === null ? null : round(stop, 8),
    takeProfit: target1 === null ? [] : [round(target1, 8), round(target2, 8)],
    riskReward: direction ? [1.5, 2.2] : null,
    indicators: { ema9: round(fast, 8), ema21: round(slow, 8), rsi14: round(momentum, 2), atr14: round(volatility, 8) },
    note: "این خروجی قانون‌محور و آزمایشی است؛ احتمال برد معتبر محاسبه نشده و تضمینی برای سود وجود ندارد."
  };
}

export default {
  async fetch(request, env) {
    const origin = env.FRONTEND_ORIGIN || DEFAULT_ORIGIN;
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "Content-Type"
      }});
    }
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "NAYA Trading AI Starter", mode: "prototype" }, 200, origin);
    if (url.pathname !== "/api/analyze") return json({ error: "Not found. Try /api/analyze?symbol=BTCUSDT&interval=15m" }, 404, origin);

    const symbol = (url.searchParams.get("symbol") || "BTCUSDT").toUpperCase();
    const allowedIntervals = new Set(["5m", "15m", "30m", "1h", "4h", "1d"]);
    const interval = url.searchParams.get("interval") || "15m";
    if (!/^[A-Z0-9]{5,20}$/.test(symbol)) return json({ error: "Invalid symbol" }, 400, origin);
    if (!allowedIntervals.has(interval)) return json({ error: "Unsupported interval" }, 400, origin);

    try {
      const endpoint = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=150`;
      const response = await fetch(endpoint, { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error(`Market data provider returned ${response.status}. Check symbol or API availability.`);
      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length < 40) throw new Error("Insufficient candle data.");
      const candles = rows.map(r => ({
        time: Number(r[0]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4])
      }));
      return json(analyze(symbol, interval, candles), 200, origin);
    } catch (e) {
      return json({ error: e.message || "Market data unavailable", hint: "Check the symbol, network access, and public Binance API availability." }, 502, origin);
    }
  }
};
