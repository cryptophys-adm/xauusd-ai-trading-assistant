# RFC: the content agent (public posts and streams from the system's analysis)

Status: proposed 2026-11-14. P0 (news in shadow) and P1 (the public projection and the content guardian) built
2026-11-14; nothing publishes yet. Owner, 2026-11-14: the next roadmap is an autonomous digital
content creator on Instagram and X, and chart livestreams on YouTube and TikTok; "roadmap streaming kita
simpan dulu sementara pakai opsi manual stream dari desktop saja". Open steps: `docs/BACKLOG.md` item 26.

## 0. Goal and the one constraint that shapes it

The system so far is private: every decision, level and account figure stays inside the owner's Workers
and Nexus. Publishing turns the question of "which data is best" into "which data may be shown to the
public", and that decides the stack:

| Data | Internal use | Public use |
|---|---|---|
| TradingView bars and macro (MCP, the owner's account) | Yes, unchanged | No: the data is licensed for the account's own use |
| TradingView charts (the chart image itself) | Yes | Yes, with TradingView's attribution visible at all times (TradingView's policy on charts in video broadcasts) |
| Twelve Data Basic | Not used | No: personal, internal non-display use only |
| MT5 broker bars | Fallback and execution | No |
| News (TradingView now; RSS and GDELT planned) | Yes, as material for analysis | Never republished; only our own summary and commentary, with the source named |
| The system's own analysis (stance, bias, reasoning, patterns, levels as commentary) | Yes | Yes, through the public projection below |
| Account, balance, positions, lot size, Omega state, any secret | Yes | Never |

**Moved (owner 2026-11-15):** the content engine and its studio now live in the repository `cryptophys-adm/cryptophys-cta` (`cta.cryptophys.work`), which carries this policy in its `AGENTS.md`. This RFC stays as the record of the decisions; the public projection and analysis it reads stay here (`src/public-projection.mjs`, `src/public-analysis.mjs`).

## 0.1 Content policy (owner, 2026-11-14)

The owner's decisions on what the public accounts show (Threads account **xauusd-ai-cta**; example given: a
pattern post with a chart, its lines and a level ladder, "nanti dibuat versi cryptophys"):

- **Focus on analytics and key levels** ("fokus pada hasil analytics dan key level"). Price levels are allowed
  as analysis: the Key Level Agent's zones, a pattern's lines, what undoes it, its measured projection.
- **No buy or sell advice, except buy and sell zones as information** ("Tidak boleh ada advices buy/sell,
  kecuali info buy/sell zone"): demand zones ("area beli") and supply zones ("area jual") may be shown; an
  entry, a stop, a take profit, BUY/SELL/LONG/SHORT as a signal, a lot or a rating never (the guardian's
  `signal_words` and `instruction` rules).
- **Real time for the analysis, 24 hours for the decisions** ("Real-time, hanya analisa"): zones, patterns and
  structure are posted when they form (`src/public-analysis.mjs`, `PublicProjection.analysis`); the system's
  own decisions (BUY, SELL, WAIT) appear only in the delayed recap (`src/public-projection.mjs`).
- **The chart image is a TradingView chart screenshot** with TradingView's attribution always visible, and a
  Cryptophys panel beside it with the levels (the free widget cannot draw our lines on the chart). Not a chart
  drawn from Yahoo data (owner, after the risks: Yahoo's terms forbid republishing its prices, its usual
  endpoints are unofficial, and its gold series is COMEX futures, a few dollars off the spot XAUUSD the system
  reads) and not from the account's TradingView bars or the broker's MT5 bars (licensed for internal use).

## 1. Regulation

POJK 6/2026 (OJK, 2026) asks everyone who publishes financial-sector information to declare their capacity:
education, marketing or recommendation, and lets OJK have offending content or accounts taken down. A
recommendation (a live "buy now at X, stop Y, target Z") likely needs an investment-adviser licence; whether
that reaches forex and gold is to be confirmed with a lawyer before the first post. Until then:

- The content is **education and analysis**: what the market did, what the system read and why, which pattern
  formed, what it would have taken. Never a live instruction.
- **Delay:** a decision appears in public only once it has passed, as a recap. This also protects the owner's
  own execution.
- Every post states its capacity ("edukasi") and carries a disclaimer; nothing promises a return.

## 2. Architecture (steps P1 to P4)

1. **Public projection** (AI Worker): a read-only view of past decisions without account data, prices only as
   commentary levels, older than the delay. The content agent reads nothing else.
   Built: `GET /api/public-projection` (`src/public-projection.mjs`). A recap holds the bar's time and session,
   the stance and bias, the quorum's shares, pattern names and status, the reasons and risks with every
   sentence that names a price or order wording removed, the names of the guardrail checks that held a side
   back, and the 15m outcome. No price level at all for now (stricter than "levels as commentary": the owner
   decides that later). Delay `PUBLIC_DELAY_HOURS`, default 24. A recap that would still leak is dropped.
2. **Content guardian** (built in `src/content-guardian.mjs`, beside the decision-card guard; Aether can run the same rules): every draft is checked for promised returns,
   instruction wording, missing capacity or disclaimer, missing TradingView attribution, account data and
   secrets. A failed check never publishes.
3. **Content agent** (a separate Worker): morning market brief, session recaps, post-trade recaps, and pattern
   education from the Projection Agent's catalogue (53 chart and 10 event patterns). Chart images are
   TradingView charts with attribution, captured by Cloudflare Browser Rendering; bars the system pulled are
   never rendered for the public.
   Prepared 2026-11-14 (owner: "persiapan engine post ke Instagram/threads"): the `xauusd-content` Worker,
   fixed Indonesian templates (no model writes public text), the daily recap Tuesday to Saturday at 22:17 UTC.
4. **Publishing:** Threads (text posts) and Instagram (image posts; the card image is not built yet). Built
   with publishing off (`CONTENT_PUBLISH`); every draft waits in the `ContentDesk` queue for the owner's click.
   Meta's limits are read from its own limit endpoints at run time. Earlier plan: Instagram Graph API (a professional account; about 100 API posts per rolling 24 hours) and
   X (pay per post since February 2026). At first every post waits for the owner's click in an approval queue;
   publishing alone comes later, once the guardian's record is clean, as Aether promotes anything else.

## 3. Streaming: parked (owner 2026-11-14)

The automated stream (a public broadcast page captured by a headless browser and sent over RTMP to YouTube
and TikTok, directly with ffmpeg or through Cloudflare Stream's simulcast) is parked. For now the owner streams
manually from a desktop. Rules for the manual stream, the same as the automated one would follow:

- Show TradingView charts with TradingView's attribution visible at all times.
- Never show Nexus: it holds the account, positions, Omega state and the decision before it is public.
- Talk as education, state the capacity, no live instructions; the stream key stays on the desktop.

When the automated stream is taken up again: never on the execution VPS (`mt5-ingestion-gateway` runs MT5,
OmegaExecutor and the Omega bridge, so a video encoder there competes with execution for CPU and bandwidth
and adds a browser and stream keys to the most sensitive host). A second small VPS, or Cloudflare Stream if
more than two destinations are wanted. Cloudflare Stream's live pricing must be confirmed first (sources
disagree by an order of magnitude); TikTok LIVE has account eligibility rules to check.

## 4. Data layer before any of this (P0)

- TradingView stays the internal backbone (bars, macro, Pine parity, calendar actuals); its quota fits a
  weekday since 2026-11-14 (to be confirmed by the first weekday).
- The MT5 fallback switch on "auto" (the owner's switch), so the chart never stops if the quota still runs out.
- News from publisher RSS feeds and GDELT, in shadow first, to free about 72 TradingView calls a day and to
  stop depending on TradingView for news.
