function assertNoNewlines(value, name) {
  if (typeof value !== "string") {
    throw new Error(`Invalid INI value for ${name}: expected string`);
  }
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`Invalid INI value for ${name}: forbidden control character`);
  }
}

function parseIniBlocks(rawLines) {
  const blocks = [{ header: null, nameLower: null, lines: [] }];
  for (const line of rawLines) {
    const secMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (secMatch && !/^\s*;/.test(line)) {
      blocks.push({
        header: line,
        nameLower: secMatch[1].trim().toLowerCase(),
        lines: [],
      });
    } else {
      blocks[blocks.length - 1].lines.push(line);
    }
  }
  return blocks;
}

function matchKeyLine(line) {
  if (/^\s*;/.test(line)) return null;
  const m = /^(\s*)([^=;\s][^=\s]*?)(\s*=\s*)(.*)$/.exec(line);
  if (!m) return null;
  return {
    indent: m[1],
    key: m[2],
    sep: m[3],
    value: m[4],
  };
}

function mutateSection(blocks, canonicalName, setEntries, removeKeys = []) {
  const targetLower = canonicalName.toLowerCase();
  let block = blocks.find((b) => b.nameLower === targetLower);
  if (!block) {
    block = {
      header: `[${canonicalName}]`,
      nameLower: targetLower,
      lines: [],
    };
    blocks.push(block);
  }

  const removeSet = new Set(removeKeys.map((k) => k.toLowerCase()));
  if (removeSet.size > 0) {
    block.lines = block.lines.filter((line) => {
      const parsed = matchKeyLine(line);
      return !(parsed && removeSet.has(parsed.key.toLowerCase()));
    });
  }

  for (const [key, value] of setEntries) {
    const keyLower = key.toLowerCase();
    let replaced = false;
    const nextLines = [];

    for (const line of block.lines) {
      const parsed = matchKeyLine(line);
      if (parsed && parsed.key.toLowerCase() === keyLower) {
        if (!replaced) {
          nextLines.push(`${parsed.indent}${parsed.key}${parsed.sep}${value}`);
          replaced = true;
        }
      } else {
        nextLines.push(line);
      }
    }

    if (!replaced) {
      let insertIdx = nextLines.length;
      while (insertIdx > 0 && /^\s*$/.test(nextLines[insertIdx - 1])) {
        insertIdx--;
      }
      nextLines.splice(insertIdx, 0, `${key}=${value}`);
    }

    block.lines = nextLines;
  }
}

function serializeIniBlocks(blocks, eol, hasTrailingNewline) {
  const out = [];
  for (const block of blocks) {
    if (block.header !== null) {
      out.push(block.header);
    }
    for (const line of block.lines) {
      out.push(line);
    }
  }
  const joined = out.join(eol);
  if (hasTrailingNewline && joined.length > 0) {
    return joined + eol;
  }
  return joined;
}

/**
 * Pure function to apply broker credentials and optional startup configuration to MT5 INI text.
 * Preserves comments (`;` lines), unrelated keys/sections, and line-ending style (LF or CRLF).
 *
 * @param {string} iniText
 * @param {{ server: string, login: string, password: string, takeStartup?: boolean, symbol?: string }} params
 * @returns {string}
 */
export function applyCredentials(
  iniText,
  { server, login, password, takeStartup = false, symbol = "XAUUSD" },
) {
  if (typeof iniText !== "string") {
    throw new Error("iniText must be a string");
  }
  const loginStr = typeof login === "number" ? String(login) : login;
  assertNoNewlines(server, "server");
  assertNoNewlines(loginStr, "login");
  assertNoNewlines(password, "password");

  const resolvedSymbol = symbol || "XAUUSD";
  if (takeStartup) {
    assertNoNewlines(resolvedSymbol, "symbol");
  }

  const eol = iniText.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = iniText.endsWith("\r\n") || iniText.endsWith("\n");

  const rawLines = iniText.length === 0 ? [] : iniText.split(/\r?\n/);
  if (hasTrailingNewline && rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }

  const blocks = parseIniBlocks(rawLines);

  mutateSection(blocks, "Common", [
    ["Login", loginStr],
    ["Server", server],
    ["Password", password],
  ]);

  mutateSection(blocks, "Experts", [
    ["Enable", "1"],
    ["Enabled", "1"],
    ["AllowLiveTrading", "1"],
    ["AllowDllImport", "0"],
    ["Account", "0"],
    ["Profile", "0"],
  ]);

  if (takeStartup) {
    mutateSection(
      blocks,
      "StartUp",
      [
        ["Expert", "OmegaExecutor"],
        ["Symbol", resolvedSymbol],
        ["Period", "M1"],
      ],
      ["ExpertParameters"],
    );
  }

  return serializeIniBlocks(blocks, eol, hasTrailingNewline);
}

/**
 * Pure function to clear broker credentials in MT5 INI text:
 * empties `[Common] Login` and `Password`, and sets `[Experts] AllowLiveTrading=0`.
 *
 * @param {string} iniText
 * @returns {string}
 */
export function clearCredentials(iniText) {
  if (typeof iniText !== "string") {
    throw new Error("iniText must be a string");
  }

  const eol = iniText.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = iniText.endsWith("\r\n") || iniText.endsWith("\n");

  const rawLines = iniText.length === 0 ? [] : iniText.split(/\r?\n/);
  if (hasTrailingNewline && rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }

  const blocks = parseIniBlocks(rawLines);

  mutateSection(blocks, "Common", [
    ["Login", ""],
    ["Password", ""],
  ]);

  mutateSection(blocks, "Experts", [["AllowLiveTrading", "0"]]);

  return serializeIniBlocks(blocks, eol, hasTrailingNewline);
}

/**
 * Pure function to ensure automated live trading permissions in MT5 INI text:
 * guarantees `Enable=1`, `Enabled=1`, `AllowLiveTrading=1`, `Account=0`, `Profile=0`.
 *
 * @param {string} iniText
 * @returns {string}
 */
export function ensureLiveTradingSettings(iniText) {
  const eol = iniText.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = iniText.endsWith("\r\n") || iniText.endsWith("\n");

  const rawLines = iniText.length === 0 ? [] : iniText.split(/\r?\n/);
  if (hasTrailingNewline && rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }

  const blocks = parseIniBlocks(rawLines);
  mutateSection(blocks, "Experts", [
    ["Enable", "1"],
    ["Enabled", "1"],
    ["AllowLiveTrading", "1"],
    ["AllowDllImport", "0"],
    ["Account", "0"],
    ["Profile", "0"],
  ]);

  return serializeIniBlocks(blocks, eol, hasTrailingNewline);
}
