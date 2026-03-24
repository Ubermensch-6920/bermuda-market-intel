import { useState, useEffect, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, BarChart, Bar, AreaChart, Area, Legend
} from "recharts";
import {
  Globe, Shield, Newspaper, BarChart3, ChevronRight, ExternalLink,
  Clock, RefreshCw, Activity, DollarSign, Percent, ArrowUpRight,
  ArrowDownRight, Minus, AlertTriangle, Loader
} from "lucide-react";

/* ═══════════════════════════════════════════════════════════════════
   BERMUDA MARKET INTELLIGENCE TERMINAL v5.1
   
   Architecture: Uses Anthropic API + web_search tool to fetch ALL
   live market data. No API keys, no CORS proxies, no scraping.
   Each data source = one Claude API call with web search enabled.
   
   Data Sources:
   - US Treasury yield curve (11 tenors, daily)
   - Japan JGB yield curve (11 tenors, daily)
   - UK Gilt yield curve (10 tenors, daily)
   - EUR/EIOPA yield curve (9 tenors, daily)
   - India govt bond yields (9 tenors, daily)
   - US corporate credit spreads (9 rating buckets, daily)
   ═══════════════════════════════════════════════════════════════════ */


// ─────────────────────────────────────────────────────────
// ANTHROPIC API — DATA FETCHING LAYER
// ─────────────────────────────────────────────────────────

/**
 * Calls the Anthropic API with web_search enabled and extracts
 * structured JSON from the response.
 * 
 * @param {string} prompt - The search + extraction prompt
 * @returns {object} Parsed JSON from Claude's response
 */
async function searchAndParse(prompt) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Anthropic API error ${response.status}: ${errorBody.slice(0, 200)}`);
  }

  const data = await response.json();

  // Extract all text blocks from the response content
  const textBlocks = data.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n");

  // Find JSON object in the response
  const jsonMatch = textBlocks.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON found in API response");
  }

  // Clean any markdown code fences
  const cleanJson = jsonMatch[0].replace(/```json|```/g, "").trim();
  return JSON.parse(cleanJson);
}


// ─── US Treasury Yield Curve ───

async function fetchUST() {
  return await searchAndParse(`
Search for the latest US Treasury yield curve rates (Daily Treasury Par Yield Curve Rates / CMT rates) from treasury.gov or any reliable source.

Return ONLY a JSON object (no other text) in this exact format:
{
  "date": "YYYY-MM-DD",
  "prior_date": "YYYY-MM-DD",
  "tenors": ["1M","3M","6M","1Y","2Y","3Y","5Y","7Y","10Y","20Y","30Y"],
  "yields": [number for each tenor as percentage e.g. 4.25],
  "prior_yields": [number for each tenor from the prior business day],
  "source": "source name"
}

Use the most recent available data. All yields as percentages (e.g. 4.25 not 0.0425).
If a tenor is unavailable use null. Return ONLY the JSON, no other text.`);
}


// ─── Japan JGB Yield Curve ───

async function fetchJGB() {
  return await searchAndParse(`
Search for the latest Japan Government Bond (JGB) yield curve from the Ministry of Finance Japan or any reliable source showing current JGB yields by maturity.

Return ONLY a JSON object (no other text) in this exact format:
{
  "date": "YYYY-MM-DD",
  "prior_date": "YYYY-MM-DD",
  "tenors": ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","25Y","30Y","40Y"],
  "yields": [number for each tenor as percentage e.g. 1.52],
  "prior_yields": [number for each tenor from prior day if available, else null],
  "source": "source name"
}

All yields as percentages. If a tenor is unavailable use null. Return ONLY the JSON.`);
}


// ─── UK Gilt Yield Curve ───

async function fetchGilt() {
  return await searchAndParse(`
Search for the latest UK gilt yields / UK government bond yields across maturities from Bank of England or any reliable source.

Return ONLY a JSON object (no other text) in this exact format:
{
  "date": "YYYY-MM-DD",
  "prior_date": "YYYY-MM-DD",
  "tenors": ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","25Y","30Y"],
  "yields": [number for each tenor as percentage e.g. 4.85],
  "prior_yields": [number for each tenor from prior session if available, else null],
  "source": "source name"
}

All yields as percentages. If a tenor is unavailable use null. Return ONLY the JSON.`);
}


// ─── EUR / EIOPA Yield Curve ───

async function fetchEUR() {
  return await searchAndParse(`
Search for the latest Eurozone / EUR government bond yields or ECB yield curve data across maturities. Use Germany bund yields if specific EIOPA data is unavailable.

Return ONLY a JSON object (no other text) in this exact format:
{
  "date": "YYYY-MM-DD",
  "prior_date": "YYYY-MM-DD",
  "tenors": ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","30Y"],
  "yields": [number for each tenor as percentage e.g. 2.65],
  "prior_yields": [number for each tenor from prior day if available, else null],
  "source": "source name"
}

All yields as percentages. Return ONLY the JSON.`);
}


// ─── India Government Bond Yields ───

async function fetchIndia() {
  return await searchAndParse(`
Search for the latest India government bond yields across maturities from RBI, CCIL, or any reliable source.

Return ONLY a JSON object (no other text) in this exact format:
{
  "date": "YYYY-MM-DD",
  "prior_date": "YYYY-MM-DD",
  "tenors": ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","30Y"],
  "yields": [number for each tenor as percentage e.g. 6.82],
  "prior_yields": [number for each tenor from prior day if available, else null],
  "source": "source name"
}

All yields as percentages. If a tenor is unavailable use null. Return ONLY the JSON.`);
}


// ─── US Credit Spreads ───

async function fetchCredit() {
  return await searchAndParse(`
Search for the latest US corporate bond credit spreads — ICE BofA Option-Adjusted Spreads (OAS) for investment grade, high yield, and by rating bucket (AAA, AA, A, BBB, BB, B, CCC). Check FRED or any reliable source.

Return ONLY a JSON object (no other text) in this exact format:
{
  "date": "YYYY-MM-DD",
  "spreads": {
    "ig":  {"name": "US IG",  "spread": number_in_basis_points, "prior": number, "bucket": "IG"},
    "aaa": {"name": "US AAA", "spread": number, "prior": number, "bucket": "AAA"},
    "aa":  {"name": "US AA",  "spread": number, "prior": number, "bucket": "AA"},
    "a":   {"name": "US A",   "spread": number, "prior": number, "bucket": "A"},
    "bbb": {"name": "US BBB", "spread": number, "prior": number, "bucket": "BBB"},
    "hy":  {"name": "US HY",  "spread": number, "prior": number, "bucket": "HY"},
    "bb":  {"name": "US BB",  "spread": number, "prior": number, "bucket": "BB"},
    "b":   {"name": "US B",   "spread": number, "prior": number, "bucket": "B"},
    "ccc": {"name": "US CCC", "spread": number, "prior": number, "bucket": "CCC"}
  },
  "source": "source name"
}

All spreads in basis points (e.g. 98 not 0.98). Use the most recent available values. Return ONLY the JSON.`);
}


// ─────────────────────────────────────────────────────────
// UTILITY FUNCTIONS
// ─────────────────────────────────────────────────────────

/** Format a yield value as percentage string */
const formatYield = (value) => {
  if (value == null) return "—";
  return value.toFixed(2) + "%";
};

/** Calculate basis point change between current and prior */
const calcChangeBp = (current, prior) => {
  if (current == null || prior == null) return null;
  return ((current - prior) * 100).toFixed(1);
};

/** Get color for a change value (red = up, green = down) */
const getChangeColor = (value) => {
  if (value > 0) return "#ef4444";
  if (value < 0) return "#22c55e";
  return "#64748b";
};

/** Get appropriate arrow icon for change direction */
const ChangeIcon = ({ value }) => {
  const num = parseFloat(value);
  if (num > 0) return <ArrowUpRight size={14} />;
  if (num < 0) return <ArrowDownRight size={14} />;
  return <Minus size={14} />;
};

/** Format a date string to relative time */
const timeAgo = (dateStr) => {
  const now = new Date();
  const date = new Date(dateStr);
  const hoursAgo = Math.floor((now - date) / 3600000);

  if (hoursAgo < 1) return "Now";
  if (hoursAgo < 24) return `${hoursAgo}h ago`;

  const daysAgo = Math.floor(hoursAgo / 24);
  if (daysAgo < 7) return `${daysAgo}d ago`;

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};


// ─────────────────────────────────────────────────────────
// SHARED UI COMPONENTS
// ─────────────────────────────────────────────────────────

/** Colored badge for categories/topics */
const Badge = ({ children, color = "#3b82f6" }) => (
  <span
    style={{
      fontSize: 10,
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: "0.08em",
      padding: "2px 8px",
      borderRadius: 4,
      background: color + "18",
      color: color,
      whiteSpace: "nowrap",
    }}
  >
    {children}
  </span>
);


/** Data freshness indicator with date and source */
const DataFreshness = ({ date, source }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      fontSize: 11,
      color: "#64748b",
      flexWrap: "wrap",
      marginTop: 4,
    }}
  >
    <Clock size={12} />
    <span>As of {date || "—"}</span>
    {source && (
      <>
        <span style={{ color: "#334155" }}>|</span>
        <span style={{ color: "#94a3b8" }}>{source}</span>
      </>
    )}
  </div>
);


/** Tooltip for yield curve charts */
const CurveTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;

  return (
    <div
      style={{
        background: "#1a1d23",
        border: "1px solid #2a2d35",
        borderRadius: 6,
        padding: "10px 14px",
        fontSize: 12,
      }}
    >
      <div style={{ color: "#94a3b8", marginBottom: 4, fontWeight: 600 }}>
        {label}
      </div>
      {payload
        .filter((p) => p.value != null)
        .map((p, i) => (
          <div
            key={i}
            style={{
              color: p.color,
              display: "flex",
              gap: 8,
              alignItems: "center",
              marginBottom: 2,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: p.color,
                display: "inline-block",
              }}
            />
            <span>
              {p.name}: {p.value?.toFixed(2)}%
            </span>
          </div>
        ))}
    </div>
  );
};


/** Tooltip for spread bar charts */
const SpreadTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;

  return (
    <div
      style={{
        background: "#1a1d23",
        border: "1px solid #2a2d35",
        borderRadius: 6,
        padding: "10px 14px",
        fontSize: 12,
      }}
    >
      <div style={{ color: "#94a3b8", marginBottom: 4, fontWeight: 600 }}>
        {label}
      </div>
      {payload
        .filter((p) => p.value != null)
        .map((p, i) => (
          <div
            key={i}
            style={{
              color: p.color,
              display: "flex",
              gap: 8,
              alignItems: "center",
              marginBottom: 2,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: p.color,
                display: "inline-block",
              }}
            />
            <span>
              {p.name}: {p.value}bp
            </span>
          </div>
        ))}
    </div>
  );
};


/** Key rate metric card with loading state */
const MetricCard = ({ label, value, change, loading: isLoading }) => {
  const numChange = parseFloat(change);
  const color = getChangeColor(numChange);

  return (
    <div
      style={{
        background: "#12141a",
        border: "1px solid #1e2028",
        borderRadius: 8,
        padding: "14px 18px",
        minWidth: 160,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "#64748b",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          marginBottom: 6,
        }}
      >
        {label}
      </div>

      {isLoading ? (
        <div style={{ height: 28, display: "flex", alignItems: "center" }}>
          <Loader
            size={16}
            style={{ color: "#3b82f6", animation: "spin 1s linear infinite" }}
          />
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: "#e2e8f0",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {value}
          </span>

          {change != null && !isNaN(numChange) && (
            <span
              style={{
                fontSize: 12,
                color: color,
                display: "flex",
                alignItems: "center",
                gap: 2,
                fontWeight: 600,
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              <ChangeIcon value={change} />
              {Math.abs(numChange).toFixed(1)}bp
            </span>
          )}
        </div>
      )}
    </div>
  );
};


// ─────────────────────────────────────────────────────────
// SOVEREIGN YIELD SECTION
// Chart + Table combined, with loading and error states
// ─────────────────────────────────────────────────────────

const SovereignYieldSection = ({
  data,
  title,
  accentColor,
  loading: isLoading,
  error,
}) => {
  // Loading state
  if (isLoading) {
    return (
      <div
        style={{
          background: "#0d0f14",
          border: "1px solid #1e2028",
          borderRadius: 10,
          padding: 40,
          textAlign: "center",
          color: "#64748b",
        }}
      >
        <Loader
          size={24}
          style={{
            animation: "spin 1s linear infinite",
            margin: "0 auto 10px",
            display: "block",
            color: "#3b82f6",
          }}
        />
        Loading {title}…
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div
        style={{
          background: "#0d0f14",
          border: "1px solid #1e2028",
          borderRadius: 10,
          padding: "20px",
        }}
      >
        <h3
          style={{
            margin: "0 0 8px",
            fontSize: 15,
            fontWeight: 700,
            color: "#e2e8f0",
          }}
        >
          {title}
        </h3>
        <div style={{ color: "#ef4444", fontSize: 12, lineHeight: 1.6 }}>
          <AlertTriangle
            size={14}
            style={{ verticalAlign: "middle", marginRight: 6 }}
          />
          {error}
        </div>
      </div>
    );
  }

  // No data yet
  if (!data) return null;

  // Build chart/table data
  const curveData = data.tenors.map((tenor, i) => ({
    tenor,
    current: data.yields[i],
    prior: data.prior_yields?.[i],
    change:
      data.yields[i] != null && data.prior_yields?.[i] != null
        ? ((data.yields[i] - data.prior_yields[i]) * 100).toFixed(1)
        : null,
  }));

  const hasPrior = data.prior_yields?.some((v) => v != null);

  return (
    <div
      style={{
        background: "#0d0f14",
        border: "1px solid #1e2028",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "14px 20px",
          borderBottom: "1px solid #1e2028",
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 15,
            fontWeight: 700,
            color: "#e2e8f0",
          }}
        >
          {title}
        </h3>
        <DataFreshness date={data.date} source={data.source} />
      </div>

      {/* Chart */}
      <div style={{ padding: "12px 12px 4px" }}>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={curveData}>
            <defs>
              <linearGradient
                id={`grad-${accentColor.slice(1)}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="5%"
                  stopColor={accentColor}
                  stopOpacity={0.25}
                />
                <stop
                  offset="95%"
                  stopColor={accentColor}
                  stopOpacity={0}
                />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1a1d23" />
            <XAxis
              dataKey="tenor"
              tick={{ fill: "#64748b", fontSize: 11 }}
              axisLine={{ stroke: "#1e2028" }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: "#64748b", fontSize: 11 }}
              axisLine={{ stroke: "#1e2028" }}
              tickLine={false}
              domain={["auto", "auto"]}
              tickFormatter={(v) => v?.toFixed(1)}
            />
            <Tooltip content={<CurveTooltip />} />
            <Area
              type="monotone"
              dataKey="current"
              stroke={accentColor}
              strokeWidth={2.5}
              fill={`url(#grad-${accentColor.slice(1)})`}
              name="Current"
              dot={{ r: 3, fill: accentColor }}
              connectNulls
            />
            {hasPrior && (
              <Line
                type="monotone"
                dataKey="prior"
                stroke="#475569"
                strokeWidth={1.5}
                strokeDasharray="5 5"
                name="Prior"
                dot={false}
                connectNulls
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Table */}
      <div style={{ padding: "0 20px 14px", overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 12,
          }}
        >
          <thead>
            <tr style={{ borderBottom: "1px solid #1e2028" }}>
              {["Tenor", "Yield", "Prior", "Chg (bp)"].map((header) => (
                <th
                  key={header}
                  style={{
                    textAlign: header === "Tenor" ? "left" : "right",
                    padding: "6px 10px",
                    color: "#64748b",
                    fontWeight: 600,
                    fontSize: 11,
                  }}
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {curveData.map((row, i) => {
              const changeNum = parseFloat(row.change);
              return (
                <tr
                  key={i}
                  style={{ borderBottom: "1px solid #13151b" }}
                >
                  <td
                    style={{
                      padding: "5px 10px",
                      color: "#e2e8f0",
                      fontWeight: 600,
                      fontFamily: "monospace",
                    }}
                  >
                    {row.tenor}
                  </td>
                  <td
                    style={{
                      padding: "5px 10px",
                      color: "#e2e8f0",
                      textAlign: "right",
                      fontFamily: "monospace",
                    }}
                  >
                    {formatYield(row.current)}
                  </td>
                  <td
                    style={{
                      padding: "5px 10px",
                      color: "#94a3b8",
                      textAlign: "right",
                      fontFamily: "monospace",
                    }}
                  >
                    {formatYield(row.prior)}
                  </td>
                  <td
                    style={{
                      padding: "5px 10px",
                      textAlign: "right",
                      fontFamily: "monospace",
                      color: getChangeColor(changeNum),
                      fontWeight: 600,
                    }}
                  >
                    {row.change != null
                      ? (changeNum > 0 ? "+" : "") + row.change
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};


// ─────────────────────────────────────────────────────────
// CREDIT SPREAD SECTION
// ─────────────────────────────────────────────────────────

const CreditSpreadSection = ({ data, loading: isLoading, error }) => {
  // Loading state
  if (isLoading) {
    return (
      <div
        style={{
          background: "#0d0f14",
          border: "1px solid #1e2028",
          borderRadius: 10,
          padding: 40,
          textAlign: "center",
          color: "#64748b",
        }}
      >
        <Loader
          size={24}
          style={{
            animation: "spin 1s linear infinite",
            margin: "0 auto 10px",
            display: "block",
            color: "#3b82f6",
          }}
        />
        Loading credit spreads…
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div
        style={{
          background: "#0d0f14",
          border: "1px solid #1e2028",
          borderRadius: 10,
          padding: "20px",
        }}
      >
        <h3
          style={{
            margin: "0 0 8px",
            fontSize: 15,
            fontWeight: 700,
            color: "#e2e8f0",
          }}
        >
          Credit Spreads
        </h3>
        <div style={{ color: "#ef4444", fontSize: 12 }}>
          <AlertTriangle
            size={14}
            style={{ verticalAlign: "middle", marginRight: 6 }}
          />
          {error}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const entries = Object.values(data.spreads || {}).filter(
    (e) => e.spread != null
  );

  return (
    <div
      style={{
        background: "#0d0f14",
        border: "1px solid #1e2028",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "14px 20px",
          borderBottom: "1px solid #1e2028",
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 15,
            fontWeight: 700,
            color: "#e2e8f0",
          }}
        >
          US Corporate Credit Spreads (OAS to Treasuries)
        </h3>
        <DataFreshness date={data.date} source={data.source} />
      </div>

      {/* Table */}
      <div style={{ padding: "8px 20px", overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 12,
          }}
        >
          <thead>
            <tr style={{ borderBottom: "1px solid #1e2028" }}>
              {["Index", "OAS (bp)", "Prior", "Chg"].map((header) => (
                <th
                  key={header}
                  style={{
                    textAlign: header === "Index" ? "left" : "right",
                    padding: "6px 10px",
                    color: "#64748b",
                    fontWeight: 600,
                    fontSize: 11,
                  }}
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((row, i) => {
              const change = (row.spread || 0) - (row.prior || 0);
              const isHY = ["HY", "BB", "B", "CCC"].includes(row.bucket);

              return (
                <tr
                  key={i}
                  style={{ borderBottom: "1px solid #13151b" }}
                >
                  <td
                    style={{
                      padding: "6px 10px",
                      color: "#e2e8f0",
                      fontWeight: 600,
                    }}
                  >
                    {row.name}{" "}
                    <Badge color={isHY ? "#ef4444" : "#22c55e"}>
                      {row.bucket}
                    </Badge>
                  </td>
                  <td
                    style={{
                      padding: "6px 10px",
                      color: "#e2e8f0",
                      textAlign: "right",
                      fontFamily: "monospace",
                      fontWeight: 700,
                    }}
                  >
                    {row.spread}
                  </td>
                  <td
                    style={{
                      padding: "6px 10px",
                      color: "#94a3b8",
                      textAlign: "right",
                      fontFamily: "monospace",
                    }}
                  >
                    {row.prior || "—"}
                  </td>
                  <td
                    style={{
                      padding: "6px 10px",
                      textAlign: "right",
                      fontFamily: "monospace",
                      color: getChangeColor(change * -1),
                      fontWeight: 600,
                    }}
                  >
                    {row.prior
                      ? (change > 0 ? "+" : "") + change
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};


// ─────────────────────────────────────────────────────────
// NEWS SECTION (curated — RSS requires server-side)
// ─────────────────────────────────────────────────────────

const CURATED_NEWS = [
  {
    id: 1,
    title: "UK gilt 10Y hits 5% for first time since 2008",
    source: "CNBC",
    date: "2026-03-20T09:30:00Z",
    topic: "Rates & Macro",
    summary: "Energy surge + hawkish BOE.",
  },
  {
    id: 2,
    title: "BOJ holds; Takata dissents, calls for 25bp hike to 1%",
    source: "Reuters",
    date: "2026-03-19T08:00:00Z",
    topic: "Rates & Macro",
    summary: "Ueda signals possible rate hike.",
  },
  {
    id: 3,
    title: "Apollo raises $8.2B for insurance private credit fund",
    source: "Reuters",
    date: "2026-03-20T14:30:00Z",
    topic: "Private Credit",
    summary: "IG private placements for insurance balance sheets.",
  },
  {
    id: 4,
    title: "BOE holds at 3.75% unanimously; inflation warning",
    source: "FT",
    date: "2026-03-20T10:00:00Z",
    topic: "Rates & Macro",
    summary: "Markets price in rate hikes rather than cuts.",
  },
  {
    id: 5,
    title: "Bermuda reinsurer completes $1.5B structured credit acquisition",
    source: "Insurance Insider",
    date: "2026-03-19T16:45:00Z",
    topic: "Structured Credit",
    summary: "CLO/ABS portfolio to Class E insurer.",
  },
  {
    id: 6,
    title: "NAIC proposes enhanced insurer private credit reporting",
    source: "AM Best",
    date: "2026-03-19T14:20:00Z",
    topic: "Insurance AM",
    summary: "More transparency on illiquid assets.",
  },
];

const TOPIC_COLORS = {
  "Private Credit": "#8b5cf6",
  "Credit Markets": "#3b82f6",
  "Rates & Macro": "#22c55e",
  "Structured Credit": "#f59e0b",
  "Insurance AM": "#ec4899",
  "Pension/Insurance": "#14b8a6",
};

const NewsSection = () => {
  const topics = [...new Set(CURATED_NEWS.map((n) => n.topic))];
  const [selectedTopic, setSelectedTopic] = useState("All");

  const filtered =
    selectedTopic === "All"
      ? CURATED_NEWS
      : CURATED_NEWS.filter((n) => n.topic === selectedTopic);

  return (
    <div
      style={{
        background: "#0d0f14",
        border: "1px solid #1e2028",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      {/* Header with topic filters */}
      <div
        style={{
          padding: "14px 20px",
          borderBottom: "1px solid #1e2028",
        }}
      >
        <h3
          style={{
            margin: "0 0 10px",
            fontSize: 15,
            fontWeight: 700,
            color: "#e2e8f0",
          }}
        >
          <Newspaper
            size={16}
            style={{ verticalAlign: "middle", marginRight: 8 }}
          />
          Financial Markets News
        </h3>

        <div
          style={{
            fontSize: 11,
            color: "#f59e0b",
            marginBottom: 8,
          }}
        >
          <AlertTriangle
            size={12}
            style={{ verticalAlign: "middle", marginRight: 4 }}
          />
          Curated headlines — live RSS requires the GitHub Actions pipeline.
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {["All", ...topics].map((topic) => (
            <button
              key={topic}
              onClick={() => setSelectedTopic(topic)}
              style={{
                background:
                  selectedTopic === topic
                    ? TOPIC_COLORS[topic] || "#3b82f6"
                    : "transparent",
                border: `1px solid ${
                  selectedTopic === topic
                    ? TOPIC_COLORS[topic] || "#3b82f6"
                    : "#2a2d35"
                }`,
                borderRadius: 20,
                padding: "4px 14px",
                fontSize: 11,
                color: selectedTopic === topic ? "#fff" : "#94a3b8",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              {topic}
            </button>
          ))}
        </div>
      </div>

      {/* News items */}
      <div style={{ maxHeight: 500, overflowY: "auto" }}>
        {filtered.map((item) => (
          <div
            key={item.id}
            style={{
              padding: "12px 20px",
              borderBottom: "1px solid #13151b",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "#12141a")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                marginBottom: 4,
              }}
            >
              <Badge color={TOPIC_COLORS[item.topic] || "#3b82f6"}>
                {item.topic}
              </Badge>
              <span style={{ fontSize: 11, color: "#475569" }}>
                {item.source} • {timeAgo(item.date)}
              </span>
            </div>
            <h4
              style={{
                margin: "0 0 3px",
                fontSize: 13,
                fontWeight: 600,
                color: "#e2e8f0",
                lineHeight: 1.4,
              }}
            >
              {item.title}
            </h4>
            <p
              style={{
                margin: 0,
                fontSize: 12,
                color: "#64748b",
                lineHeight: 1.5,
              }}
            >
              {item.summary}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
};


// ─────────────────────────────────────────────────────────
// BMA REGULATORY UPDATES SECTION (curated)
// ─────────────────────────────────────────────────────────

const BMA_UPDATES = [
  {
    id: 1,
    title: "Notice – Pre-Approval for New Insurance Registrations",
    date: "2026-03-19",
    category: "Licensing",
    summary: "Updated Class D/E requirements.",
    isNew: true,
  },
  {
    id: 2,
    title: "Notice – Regulatory Burden Reduction",
    date: "2026-02-19",
    category: "Governance",
    summary: "Streamlined reporting for commercial insurers.",
    isNew: true,
  },
  {
    id: 3,
    title: "Notice – 2025 Year-End BSCR Model Republication",
    date: "2026-02-18",
    category: "Capital/Solvency",
    summary: "Republished BSCR with optional data validation.",
    isNew: true,
  },
  {
    id: 4,
    title: "DP – AI Governance Framework",
    date: "2026-02-09",
    category: "Governance",
    summary: "AI risk management framework. Final proposal Q3 2026.",
    isNew: true,
  },
  {
    id: 5,
    title: "CP – Prudent Person Principle",
    date: "2025-12-15",
    category: "Investment",
    summary: "PPP guidance for NPTA allocations.",
    isNew: false,
  },
  {
    id: 6,
    title: "Class C,D,E Solvency Amendment Rules 2025",
    date: "2025-12-01",
    category: "Capital/Solvency",
    summary: "New A&L Statement disclosure. Effective Jan 1 2026.",
    isNew: false,
  },
];

const CATEGORY_COLORS = {
  "Capital/Solvency": "#ef4444",
  Investment: "#f59e0b",
  Governance: "#8b5cf6",
  Disclosure: "#3b82f6",
  Licensing: "#22c55e",
  "Stress Testing": "#ec4899",
};

const BMASection = () => {
  const categories = [...new Set(BMA_UPDATES.map((u) => u.category))];
  const [selectedCat, setSelectedCat] = useState("All");

  const filtered =
    selectedCat === "All"
      ? BMA_UPDATES
      : BMA_UPDATES.filter((u) => u.category === selectedCat);

  return (
    <div
      style={{
        background: "#0d0f14",
        border: "1px solid #1e2028",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      {/* Header with category filters */}
      <div
        style={{
          padding: "14px 20px",
          borderBottom: "1px solid #1e2028",
        }}
      >
        <h3
          style={{
            margin: "0 0 10px",
            fontSize: 15,
            fontWeight: 700,
            color: "#e2e8f0",
          }}
        >
          <Shield
            size={16}
            style={{ verticalAlign: "middle", marginRight: 8 }}
          />
          BMA Regulatory Updates
        </h3>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {["All", ...categories].map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCat(cat)}
              style={{
                background:
                  selectedCat === cat
                    ? CATEGORY_COLORS[cat] || "#3b82f6"
                    : "transparent",
                border: `1px solid ${
                  selectedCat === cat
                    ? CATEGORY_COLORS[cat] || "#3b82f6"
                    : "#2a2d35"
                }`,
                borderRadius: 20,
                padding: "4px 14px",
                fontSize: 11,
                color: selectedCat === cat ? "#fff" : "#94a3b8",
                cursor: "pointer",
                fontWeight: 500,
              }}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Update items */}
      <div>
        {filtered.map((item) => (
          <div
            key={item.id}
            style={{
              padding: "12px 20px",
              borderBottom: "1px solid #13151b",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "#12141a")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                marginBottom: 4,
              }}
            >
              <Badge
                color={CATEGORY_COLORS[item.category] || "#3b82f6"}
              >
                {item.category}
              </Badge>
              {item.isNew && <Badge color="#22c55e">NEW</Badge>}
              <span style={{ fontSize: 11, color: "#475569" }}>
                {item.date}
              </span>
            </div>
            <h4
              style={{
                margin: "0 0 3px",
                fontSize: 13,
                fontWeight: 600,
                color: "#e2e8f0",
                lineHeight: 1.4,
              }}
            >
              {item.title}
            </h4>
            <p
              style={{
                margin: 0,
                fontSize: 12,
                color: "#64748b",
                lineHeight: 1.5,
              }}
            >
              {item.summary}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
};


// ─────────────────────────────────────────────────────────
// NAVIGATION CONFIG
// ─────────────────────────────────────────────────────────

const PAGES = [
  { id: "home", label: "Overview", icon: Activity },
  { id: "ust", label: "US Treasuries", icon: DollarSign },
  { id: "jgb", label: "Japan JGB", icon: Globe },
  { id: "gilt", label: "UK Gilts", icon: Globe },
  { id: "eiopa", label: "EIOPA EUR", icon: Globe },
  { id: "india", label: "India Govt", icon: Globe },
  { id: "credit", label: "Credit Spreads", icon: Percent },
  { id: "news", label: "News", icon: Newspaper },
  { id: "bma", label: "BMA Updates", icon: Shield },
];


// ─────────────────────────────────────────────────────────
// MAIN APP COMPONENT
// ─────────────────────────────────────────────────────────

export default function App() {
  // ── Navigation state ──
  const [page, setPage] = useState("home");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [clock, setClock] = useState("");

  // ── Data stores (one per source) ──
  const [ustData, setUstData] = useState(null);
  const [jgbData, setJgbData] = useState(null);
  const [giltData, setGiltData] = useState(null);
  const [eiopaData, setEiopaData] = useState(null);
  const [indiaData, setIndiaData] = useState(null);
  const [creditData, setCreditData] = useState(null);

  // ── Loading & error state (per source) ──
  const [loadingState, setLoadingState] = useState({});
  const [errors, setErrors] = useState({});
  const [globalLoading, setGlobalLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);

  // ── Clock ──
  useEffect(() => {
    const interval = setInterval(() => {
      setClock(
        new Date().toLocaleTimeString("en-US", { hour12: false })
      );
    }, 1000);
    setClock(
      new Date().toLocaleTimeString("en-US", { hour12: false })
    );
    return () => clearInterval(interval);
  }, []);

  // ── Master refresh function ──
  const refreshAll = useCallback(async () => {
    setGlobalLoading(true);
    setLoadingState({
      ust: true, jgb: true, gilt: true,
      eiopa: true, india: true, credit: true,
    });
    setErrors({});

    const newErrors = {};

    // Helper: run a single fetcher with error handling
    const runFetcher = async (key, fetchFn, setter) => {
      try {
        const data = await fetchFn();
        setter(data);
      } catch (error) {
        newErrors[key] = error.message;
      } finally {
        setLoadingState((prev) => ({ ...prev, [key]: false }));
      }
    };

    // Run all fetchers in parallel
    await Promise.all([
      runFetcher("ust", fetchUST, setUstData),
      runFetcher("jgb", fetchJGB, setJgbData),
      runFetcher("gilt", fetchGilt, setGiltData),
      runFetcher("eiopa", fetchEUR, setEiopaData),
      runFetcher("india", fetchIndia, setIndiaData),
      runFetcher("credit", fetchCredit, setCreditData),
    ]);

    setErrors(newErrors);
    setLastRefresh(new Date());
    setGlobalLoading(false);
  }, []);

  // ── Auto-fetch on mount ──
  useEffect(() => {
    refreshAll();
  }, []);

  // ── Derived values for overview cards ──
  const getValue = (data, tenor) => {
    if (!data) return null;
    const idx = data.tenors?.indexOf(tenor);
    return idx >= 0 ? data.yields?.[idx] : null;
  };

  const getPrior = (data, tenor) => {
    if (!data) return null;
    const idx = data.tenors?.indexOf(tenor);
    return idx >= 0 ? data.prior_yields?.[idx] : null;
  };

  const ust10y = getValue(ustData, "10Y");
  const ust10yPrior = getPrior(ustData, "10Y");
  const ust2y = getValue(ustData, "2Y");
  const ust2yPrior = getPrior(ustData, "2Y");
  const jgb10y = getValue(jgbData, "10Y");
  const jgb10yPrior = getPrior(jgbData, "10Y");
  const gilt10y = getValue(giltData, "10Y");
  const gilt10yPrior = getPrior(giltData, "10Y");
  const india10y = getValue(indiaData, "10Y");
  const india10yPrior = getPrior(indiaData, "10Y");

  const igSpread = creditData?.spreads?.ig?.spread;
  const igPrior = creditData?.spreads?.ig?.prior;
  const hySpread = creditData?.spreads?.hy?.spread;
  const hyPrior = creditData?.spreads?.hy?.prior;

  // ── Global yield curve comparison data ──
  const comparisonTenors = ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"];
  const multiCurveData = comparisonTenors.map((tenor) => ({
    tenor,
    UST: getValue(ustData, tenor),
    JGB: getValue(jgbData, tenor),
    Gilt: getValue(giltData, tenor),
    EUR: getValue(eiopaData, tenor),
    India: getValue(indiaData, tenor),
  }));
  const hasAnyCurve = ustData || jgbData || giltData || eiopaData || indiaData;

  // ── Page renderer ──
  const renderPage = () => {
    switch (page) {
      case "ust":
        return (
          <SovereignYieldSection
            data={ustData}
            title="US Treasury Par Yield Curve (CMT)"
            accentColor="#3b82f6"
            loading={loadingState.ust}
            error={errors.ust}
          />
        );
      case "jgb":
        return (
          <SovereignYieldSection
            data={jgbData}
            title="Japan Government Bond Yields (JGB)"
            accentColor="#ef4444"
            loading={loadingState.jgb}
            error={errors.jgb}
          />
        );
      case "gilt":
        return (
          <SovereignYieldSection
            data={giltData}
            title="UK Gilt Nominal Par Yields"
            accentColor="#22c55e"
            loading={loadingState.gilt}
            error={errors.gilt}
          />
        );
      case "eiopa":
        return (
          <SovereignYieldSection
            data={eiopaData}
            title="EUR Govt Yield Curve (ECB/Bunds — EIOPA proxy)"
            accentColor="#f59e0b"
            loading={loadingState.eiopa}
            error={errors.eiopa}
          />
        );
      case "india":
        return (
          <SovereignYieldSection
            data={indiaData}
            title="India Government Bond Yields"
            accentColor="#ec4899"
            loading={loadingState.india}
            error={errors.india}
          />
        );
      case "credit":
        return (
          <CreditSpreadSection
            data={creditData}
            loading={loadingState.credit}
            error={errors.credit}
          />
        );
      case "news":
        return <NewsSection />;
      case "bma":
        return <BMASection />;

      // ── OVERVIEW PAGE (default) ──
      default:
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

            {/* Error banner */}
            {Object.keys(errors).length > 0 && (
              <div
                style={{
                  background: "#1a0a0a",
                  border: "1px solid #7f1d1d",
                  borderRadius: 10,
                  padding: "12px 20px",
                }}
              >
                <div
                  style={{
                    color: "#ef4444",
                    fontWeight: 700,
                    fontSize: 12,
                    marginBottom: 4,
                  }}
                >
                  <AlertTriangle
                    size={14}
                    style={{ verticalAlign: "middle", marginRight: 4 }}
                  />
                  Some sources had errors:
                </div>
                {Object.entries(errors).map(([key, msg]) => (
                  <div
                    key={key}
                    style={{ color: "#a3a3a3", fontSize: 11 }}
                  >
                    • <strong>{key}</strong>: {msg}
                  </div>
                ))}
              </div>
            )}

            {/* ── Key Rates Snapshot ── */}
            <div>
              <h3
                style={{
                  margin: "0 0 10px",
                  fontSize: 13,
                  fontWeight: 700,
                  color: "#64748b",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                }}
              >
                Key Rates {ustData ? `(${ustData.date})` : ""}
              </h3>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fill, minmax(165px, 1fr))",
                  gap: 10,
                }}
              >
                <MetricCard
                  label="UST 10Y"
                  value={formatYield(ust10y)}
                  change={calcChangeBp(ust10y, ust10yPrior)}
                  loading={loadingState.ust}
                />
                <MetricCard
                  label="UST 2Y"
                  value={formatYield(ust2y)}
                  change={calcChangeBp(ust2y, ust2yPrior)}
                  loading={loadingState.ust}
                />
                <MetricCard
                  label="UST 2s10s"
                  value={
                    ust10y != null && ust2y != null
                      ? ((ust10y - ust2y) * 100).toFixed(0) + "bp"
                      : "—"
                  }
                  change={
                    ust10yPrior != null
                      ? calcChangeBp(
                          ust10y - ust2y,
                          ust10yPrior - ust2yPrior
                        )
                      : null
                  }
                  loading={loadingState.ust}
                />
                <MetricCard
                  label="JGB 10Y"
                  value={formatYield(jgb10y)}
                  change={calcChangeBp(jgb10y, jgb10yPrior)}
                  loading={loadingState.jgb}
                />
                <MetricCard
                  label="UK Gilt 10Y"
                  value={formatYield(gilt10y)}
                  change={calcChangeBp(gilt10y, gilt10yPrior)}
                  loading={loadingState.gilt}
                />
                <MetricCard
                  label="India 10Y"
                  value={formatYield(india10y)}
                  change={calcChangeBp(india10y, india10yPrior)}
                  loading={loadingState.india}
                />
                <MetricCard
                  label="US IG OAS"
                  value={
                    igSpread != null ? igSpread + "bp" : "—"
                  }
                  change={
                    igPrior != null
                      ? (igSpread - igPrior).toFixed(0)
                      : null
                  }
                  loading={loadingState.credit}
                />
                <MetricCard
                  label="US HY OAS"
                  value={
                    hySpread != null ? hySpread + "bp" : "—"
                  }
                  change={
                    hyPrior != null
                      ? (hySpread - hyPrior).toFixed(0)
                      : null
                  }
                  loading={loadingState.credit}
                />
              </div>
            </div>

            {/* ── Global Yield Curve Comparison ── */}
            {hasAnyCurve && (
              <div
                style={{
                  background: "#0d0f14",
                  border: "1px solid #1e2028",
                  borderRadius: 10,
                  padding: "14px 14px 6px",
                }}
              >
                <h3
                  style={{
                    margin: "0 0 10px 6px",
                    fontSize: 13,
                    fontWeight: 700,
                    color: "#64748b",
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                  }}
                >
                  Global Yield Curve Comparison (1Y–30Y)
                </h3>

                {/* Chart */}
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={multiCurveData}>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="#1a1d23"
                    />
                    <XAxis
                      dataKey="tenor"
                      tick={{ fill: "#64748b", fontSize: 11 }}
                      axisLine={{ stroke: "#1e2028" }}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fill: "#64748b", fontSize: 11 }}
                      axisLine={{ stroke: "#1e2028" }}
                      tickLine={false}
                      domain={[0, "auto"]}
                      tickFormatter={(v) => v.toFixed(1) + "%"}
                    />
                    <Tooltip content={<CurveTooltip />} />
                    <Line type="monotone" dataKey="India" stroke="#ec4899" strokeWidth={2} name="India" dot={{ r: 3 }} connectNulls />
                    <Line type="monotone" dataKey="Gilt" stroke="#22c55e" strokeWidth={2} name="UK Gilt" dot={{ r: 3 }} connectNulls />
                    <Line type="monotone" dataKey="UST" stroke="#3b82f6" strokeWidth={2.5} name="US Treasury" dot={{ r: 4 }} connectNulls />
                    <Line type="monotone" dataKey="EUR" stroke="#f59e0b" strokeWidth={2} name="EUR" dot={{ r: 3 }} connectNulls />
                    <Line type="monotone" dataKey="JGB" stroke="#ef4444" strokeWidth={2} name="Japan JGB" dot={{ r: 3 }} connectNulls />
                    <Legend
                      wrapperStyle={{
                        fontSize: 11,
                        paddingTop: 8,
                      }}
                    />
                  </LineChart>
                </ResponsiveContainer>

                {/* Comparison table */}
                <div
                  style={{
                    overflowX: "auto",
                    padding: "4px 6px 10px",
                  }}
                >
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      fontSize: 11,
                    }}
                  >
                    <thead>
                      <tr
                        style={{
                          borderBottom: "1px solid #1e2028",
                        }}
                      >
                        <th style={{ textAlign: "left", padding: "5px 8px", color: "#64748b", fontWeight: 600 }}>Tenor</th>
                        <th style={{ textAlign: "right", padding: "5px 8px", color: "#3b82f6", fontWeight: 600 }}>UST</th>
                        <th style={{ textAlign: "right", padding: "5px 8px", color: "#ef4444", fontWeight: 600 }}>JGB</th>
                        <th style={{ textAlign: "right", padding: "5px 8px", color: "#22c55e", fontWeight: 600 }}>Gilt</th>
                        <th style={{ textAlign: "right", padding: "5px 8px", color: "#f59e0b", fontWeight: 600 }}>EUR</th>
                        <th style={{ textAlign: "right", padding: "5px 8px", color: "#ec4899", fontWeight: 600 }}>India</th>
                      </tr>
                    </thead>
                    <tbody>
                      {multiCurveData.map((row, i) => (
                        <tr
                          key={i}
                          style={{
                            borderBottom: "1px solid #13151b",
                          }}
                        >
                          <td
                            style={{
                              padding: "4px 8px",
                              color: "#e2e8f0",
                              fontWeight: 600,
                              fontFamily: "monospace",
                            }}
                          >
                            {row.tenor}
                          </td>
                          {["UST", "JGB", "Gilt", "EUR", "India"].map(
                            (key) => (
                              <td
                                key={key}
                                style={{
                                  padding: "4px 8px",
                                  textAlign: "right",
                                  fontFamily: "monospace",
                                  color:
                                    row[key] != null
                                      ? "#e2e8f0"
                                      : "#334155",
                                }}
                              >
                                {row[key] != null
                                  ? row[key].toFixed(2) + "%"
                                  : "—"}
                              </td>
                            )
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Source dates */}
                <div
                  style={{
                    padding: "4px 8px 10px",
                    display: "flex",
                    gap: 16,
                    flexWrap: "wrap",
                    fontSize: 10,
                    color: "#475569",
                  }}
                >
                  {ustData && <span>UST: {ustData.date}</span>}
                  {jgbData && <span>JGB: {jgbData.date}</span>}
                  {giltData && <span>Gilt: {giltData.date}</span>}
                  {eiopaData && <span>EUR: {eiopaData.date}</span>}
                  {indiaData && <span>India: {indiaData.date}</span>}
                </div>
              </div>
            )}

            {/* ── News + BMA side by side ── */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 14,
              }}
            >
              {/* News preview */}
              <div
                style={{
                  background: "#0d0f14",
                  border: "1px solid #1e2028",
                  borderRadius: 10,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    padding: "12px 20px",
                    borderBottom: "1px solid #1e2028",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <h3
                    style={{
                      margin: 0,
                      fontSize: 13,
                      fontWeight: 700,
                      color: "#e2e8f0",
                    }}
                  >
                    <Newspaper
                      size={14}
                      style={{
                        verticalAlign: "middle",
                        marginRight: 6,
                      }}
                    />
                    Latest News
                  </h3>
                  <button
                    onClick={() => setPage("news")}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#3b82f6",
                      fontSize: 11,
                      cursor: "pointer",
                      fontWeight: 600,
                    }}
                  >
                    View All{" "}
                    <ChevronRight
                      size={12}
                      style={{ verticalAlign: "middle" }}
                    />
                  </button>
                </div>
                {CURATED_NEWS.slice(0, 4).map((item) => (
                  <div
                    key={item.id}
                    style={{
                      padding: "8px 20px",
                      borderBottom: "1px solid #13151b",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        alignItems: "center",
                        marginBottom: 2,
                      }}
                    >
                      <Badge>{item.topic}</Badge>
                      <span
                        style={{ fontSize: 10, color: "#475569" }}
                      >
                        {timeAgo(item.date)}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "#e2e8f0",
                        lineHeight: 1.4,
                      }}
                    >
                      {item.title}
                    </div>
                  </div>
                ))}
              </div>

              {/* BMA preview */}
              <div
                style={{
                  background: "#0d0f14",
                  border: "1px solid #1e2028",
                  borderRadius: 10,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    padding: "12px 20px",
                    borderBottom: "1px solid #1e2028",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <h3
                    style={{
                      margin: 0,
                      fontSize: 13,
                      fontWeight: 700,
                      color: "#e2e8f0",
                    }}
                  >
                    <Shield
                      size={14}
                      style={{
                        verticalAlign: "middle",
                        marginRight: 6,
                      }}
                    />
                    BMA Updates
                  </h3>
                  <button
                    onClick={() => setPage("bma")}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#3b82f6",
                      fontSize: 11,
                      cursor: "pointer",
                      fontWeight: 600,
                    }}
                  >
                    View All{" "}
                    <ChevronRight
                      size={12}
                      style={{ verticalAlign: "middle" }}
                    />
                  </button>
                </div>
                {BMA_UPDATES.filter((u) => u.isNew)
                  .slice(0, 4)
                  .map((item) => (
                    <div
                      key={item.id}
                      style={{
                        padding: "8px 20px",
                        borderBottom: "1px solid #13151b",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          gap: 6,
                          alignItems: "center",
                          marginBottom: 2,
                        }}
                      >
                        <Badge color="#22c55e">NEW</Badge>
                        <Badge>{item.category}</Badge>
                        <span
                          style={{
                            fontSize: 10,
                            color: "#475569",
                          }}
                        >
                          {item.date}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: "#e2e8f0",
                          lineHeight: 1.4,
                        }}
                      >
                        {item.title}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        );
    }
  };

  // ─── RENDER ───
  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        background: "#080a0f",
        color: "#e2e8f0",
        fontFamily:
          "'JetBrains Mono', 'IBM Plex Sans', -apple-system, sans-serif",
        fontSize: 13,
        overflow: "hidden",
      }}
    >
      {/* Spin animation */}
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

      {/* ═══════════ SIDEBAR ═══════════ */}
      <div
        style={{
          width: sidebarOpen ? 210 : 52,
          transition: "width 0.2s ease",
          background: "#0a0c12",
          borderRight: "1px solid #1a1d23",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        {/* Logo */}
        <div
          style={{
            padding: sidebarOpen ? "14px 16px" : "14px 10px",
            borderBottom: "1px solid #1a1d23",
            display: "flex",
            alignItems: "center",
            gap: 10,
            cursor: "pointer",
            minHeight: 52,
          }}
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              background:
                "linear-gradient(135deg, #3b82f6, #8b5cf6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <BarChart3 size={16} color="#fff" />
          </div>
          {sidebarOpen && (
            <div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 800,
                  color: "#e2e8f0",
                  letterSpacing: "-0.02em",
                  lineHeight: 1.1,
                }}
              >
                BERMUDA
              </div>
              <div
                style={{
                  fontSize: 9,
                  fontWeight: 600,
                  color: "#3b82f6",
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                }}
              >
                MARKET INTEL
              </div>
            </div>
          )}
        </div>

        {/* Navigation links */}
        <div
          style={{
            flex: 1,
            padding: "6px",
            overflowY: "auto",
          }}
        >
          {PAGES.map((p) => {
            const Icon = p.icon;
            const isActive = page === p.id;

            return (
              <button
                key={p.id}
                onClick={() => setPage(p.id)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: sidebarOpen ? "8px 10px" : "8px",
                  marginBottom: 1,
                  borderRadius: 6,
                  border: "none",
                  background: isActive
                    ? "#1e2028"
                    : "transparent",
                  color: isActive ? "#e2e8f0" : "#64748b",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: isActive ? 600 : 500,
                  textAlign: "left",
                  justifyContent: sidebarOpen
                    ? "flex-start"
                    : "center",
                }}
                onMouseEnter={(e) => {
                  if (!isActive)
                    e.currentTarget.style.background = "#12141a";
                }}
                onMouseLeave={(e) => {
                  if (!isActive)
                    e.currentTarget.style.background =
                      "transparent";
                }}
              >
                <Icon size={15} style={{ flexShrink: 0 }} />
                {sidebarOpen && <span>{p.label}</span>}
              </button>
            );
          })}
        </div>

        {/* Sidebar footer */}
        {sidebarOpen && (
          <div
            style={{
              padding: "10px 14px",
              borderTop: "1px solid #1a1d23",
              fontSize: 10,
              color: "#334155",
            }}
          >
            Powered by Claude web search
          </div>
        )}
      </div>

      {/* ═══════════ MAIN CONTENT ═══════════ */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* ── Top bar ── */}
        <div
          style={{
            height: 42,
            padding: "0 20px",
            borderBottom: "1px solid #1a1d23",
            background: "#0a0c12",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>
            {PAGES.find((p) => p.id === page)?.label || "Overview"}
          </h2>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: 11,
            }}
          >
            {lastRefresh && (
              <span style={{ color: "#475569", fontSize: 10 }}>
                Last: {lastRefresh.toLocaleTimeString()}
              </span>
            )}

            {globalLoading && (
              <Loader
                size={14}
                style={{
                  color: "#3b82f6",
                  animation: "spin 1s linear infinite",
                }}
              />
            )}

            <button
              onClick={refreshAll}
              disabled={globalLoading}
              style={{
                background: globalLoading
                  ? "#1e2028"
                  : "#3b82f6",
                border: "none",
                borderRadius: 6,
                padding: "5px 14px",
                color: globalLoading ? "#64748b" : "#fff",
                cursor: globalLoading
                  ? "not-allowed"
                  : "pointer",
                display: "flex",
                alignItems: "center",
                gap: 5,
                fontWeight: 700,
                fontSize: 12,
              }}
            >
              <RefreshCw
                size={13}
                style={{
                  animation: globalLoading
                    ? "spin 1s linear infinite"
                    : "none",
                }}
              />
              {globalLoading ? "Fetching…" : "Refresh"}
            </button>

            <span
              style={{
                color: "#3b82f6",
                fontFamily: "monospace",
                fontWeight: 700,
                fontSize: 13,
              }}
            >
              {clock}
            </span>
          </div>
        </div>

        {/* ── Page content ── */}
        <div style={{ flex: 1, overflow: "auto", padding: 18 }}>
          {renderPage()}
        </div>

        {/* ── Status bar ── */}
        <div
          style={{
            height: 26,
            padding: "0 20px",
            borderTop: "1px solid #1a1d23",
            background: "#0a0c12",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 10,
            color: "#334155",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", gap: 14 }}>
            {ust10y != null && (
              <span>UST 10Y: {formatYield(ust10y)}</span>
            )}
            {jgb10y != null && (
              <span>JGB 10Y: {formatYield(jgb10y)}</span>
            )}
            {gilt10y != null && (
              <span>Gilt 10Y: {formatYield(gilt10y)}</span>
            )}
            {india10y != null && (
              <span>India 10Y: {formatYield(india10y)}</span>
            )}
            {igSpread != null && (
              <span>IG: {igSpread}bp</span>
            )}
            {hySpread != null && (
              <span>HY: {hySpread}bp</span>
            )}
          </div>
          <span>Bermuda Market Intelligence Terminal v5.1</span>
        </div>
      </div>
    </div>
  );
}
