/**
 * WebVPN (网瑞达 WEngine) URL rewriting, in plain JS.
 *
 * The gateway scheme is:
 *
 *     <base>/<scheme>[-<port>]/<hex(iv)><hex(AES-CFB(key, iv, hostname))><path>?<query>
 *
 * Only the hostname is encrypted; the path stays readable. Key and IV are both the
 * vendor default "wrdvpnisthebest!" (16 ASCII bytes), which is why every gateway URL
 * starts with the same 77726476706e69737468656265737421 prefix.
 *
 * We need this in the extension because a page opened through the gateway produces
 * absolute publisher URLs that would otherwise bypass the campus session.
 */

const DOIWebVPN = (() => {
  const DEFAULT_KEY = "wrdvpnisthebest!";
  const CHALLENGE_TITLES = ["请稍候", "just a moment", "attention required", "正在验证"];

  // --- AES-128 encrypt (only what CFB needs) --------------------------------

  function rotl8(x, shift) {
    return ((x << shift) | (x >>> (8 - shift))) & 0xff;
  }

  const SBOX = (() => {
    const box = new Uint8Array(256);
    let p = 1;
    let q = 1;
    do {
      p = (p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
      q ^= (q << 1) & 0xff;
      q ^= (q << 2) & 0xff;
      q ^= (q << 4) & 0xff;
      q &= 0xff;
      if (q & 0x80) q ^= 0x09;
      box[p] = (q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63) & 0xff;
    } while (p !== 1);
    box[0] = 0x63;
    return box;
  })();

  function xtime(value) {
    return ((value << 1) ^ (value & 0x80 ? 0x1b : 0)) & 0xff;
  }

  function expandKey(key) {
    const rounds = 10;
    const words = new Uint8Array(16 * (rounds + 1));
    words.set(key.subarray(0, 16), 0);
    let rcon = 1;
    for (let i = 16; i < words.length; i += 4) {
      let t0 = words[i - 4];
      let t1 = words[i - 3];
      let t2 = words[i - 2];
      let t3 = words[i - 1];
      if (i % 16 === 0) {
        const first = t0;
        t0 = SBOX[t1] ^ rcon;
        t1 = SBOX[t2];
        t2 = SBOX[t3];
        t3 = SBOX[first];
        rcon = xtime(rcon);
      }
      words[i] = words[i - 16] ^ t0;
      words[i + 1] = words[i - 15] ^ t1;
      words[i + 2] = words[i - 14] ^ t2;
      words[i + 3] = words[i - 13] ^ t3;
    }
    return words;
  }

  function encryptBlock(block, roundKeys) {
    const state = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) state[i] = block[i] ^ roundKeys[i];

    for (let round = 1; round <= 10; round += 1) {
      for (let i = 0; i < 16; i += 1) state[i] = SBOX[state[i]];

      // ShiftRows (state is column-major: index = row + 4 * column)
      const shifted = new Uint8Array(16);
      for (let column = 0; column < 4; column += 1) {
        for (let row = 0; row < 4; row += 1) {
          shifted[row + 4 * column] = state[row + 4 * ((column + row) % 4)];
        }
      }
      state.set(shifted);

      if (round !== 10) {
        for (let column = 0; column < 4; column += 1) {
          const base = 4 * column;
          const a0 = state[base];
          const a1 = state[base + 1];
          const a2 = state[base + 2];
          const a3 = state[base + 3];
          const all = a0 ^ a1 ^ a2 ^ a3;
          state[base] ^= all ^ xtime(a0 ^ a1);
          state[base + 1] ^= all ^ xtime(a1 ^ a2);
          state[base + 2] ^= all ^ xtime(a2 ^ a3);
          state[base + 3] ^= all ^ xtime(a3 ^ a0);
        }
      }

      const offset = round * 16;
      for (let i = 0; i < 16; i += 1) state[i] ^= roundKeys[offset + i];
    }
    return state;
  }

  /** AES-CFB with 128-bit segments: keystream comes from the previous ciphertext block. */
  function cfbEncrypt(keyBytes, ivBytes, data) {
    const roundKeys = expandKey(keyBytes);
    const output = new Uint8Array(data.length);
    let previous = ivBytes.slice(0, 16);
    for (let offset = 0; offset < data.length; offset += 16) {
      const keystream = encryptBlock(previous, roundKeys);
      const size = Math.min(16, data.length - offset);
      for (let i = 0; i < size; i += 1) {
        output[offset + i] = data[offset + i] ^ keystream[i];
      }
      previous = output.slice(offset, offset + 16);
      while (previous.length < 16) previous = new Uint8Array([...previous, 0]);
    }
    return output;
  }

  function toHex(bytes) {
    return Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function convert(rawUrl, base) {
    if (!base) return rawUrl;
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (err) {
      return rawUrl;
    }
    const encoder = new TextEncoder();
    const key = encoder.encode(DEFAULT_KEY);
    const encrypted = cfbEncrypt(key, key, encoder.encode(parsed.hostname));
    const scheme = parsed.protocol.replace(":", "") || "https";
    const schemePart = parsed.port ? `${scheme}-${parsed.port}` : scheme;
    const path = parsed.pathname || "/";
    return `${base.replace(/\/$/, "")}/${schemePart}/${toHex(key)}${toHex(encrypted)}${path}${parsed.search}`;
  }

  function isChallengeTitle(title) {
    const text = (title || "").toLowerCase();
    return CHALLENGE_TITLES.some((marker) => text.includes(marker));
  }

  // 网关会话过期、单点登录页——同样需要人操作，不能干等到超时
  const LOGIN_MARKERS = [
    "/cas/login",
    "/login?service=",
    "/saml2",
    "/shibboleth",
    "/idp/",
    "/sso/",
    "/oauth2/authorize",
  ];

  function isLoginUrl(url) {
    const text = (url || "").toLowerCase();
    return LOGIN_MARKERS.some((marker) => text.includes(marker));
  }

  return { convert, isChallengeTitle, isLoginUrl, DEFAULT_KEY };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = DOIWebVPN;
}
