// The Guess Room — game content for Mr. Paul's two games
// Parts (POST JSON with "part"):
//   mystery { age, category, avoid }                       -> a secret answer, 5 clues (hard to easy), a picture, a wow fact
//   ask     { age, answer, aliases, clues, question, history } -> judges a yes/no question or a guess (never gives the answer away)
//   facts   { age, category, count, avoid }                -> researched Fact-or-Fiction claims with explanation, proof and source
// Env: ANTHROPIC_API_KEY (required), SERPER_API_KEY (live web research for Fact or Fiction; strongly recommended),
//      CLAUDE_MODEL (writer, default Sonnet), CLAUDE_CHECK_MODEL (quick jobs, default Haiku)
// Nothing about players is stored.

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const FAST = process.env.CLAUDE_CHECK_MODEL || "claude-haiku-5-5";
const HOURLY_LIMIT = 150;
const hits = new Map();

const AGE = {
  junior: { who: "children ages 5 to 10", style: "Use very simple words and short sentences. Be silly, warm and encouraging. Only things a young child would know or love: everyday animals, foods, toys, famous cartoon-style things, simple space and nature facts. No scary or sad topics." },
  teen: { who: "kids and teens ages 11 to 17", style: "Middle and high school level. Fun, upbeat, a little playful. Things a teen would know from school, sports, music, movies, games and the internet." },
  adult: { who: "adults (18+)", style: "Smart, witty, a bit of a classy game-show host. Deeper and more surprising knowledge, with some nostalgia from the 1950s to today." }
};
const SAFE = "Everything must be family-friendly and true to the facts. Never about current politics, elections, religion debates, tragedies, violence, crime, drugs, or anything mean about groups of people. No private people.";

// ---------- helpers ----------
async function anthropic(body) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body)
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("api_" + r.status + " " + t.slice(0, 200)); }
  return r.json();
}
async function callTool(system, tool, user, maxTokens, check, model) {
  const m = model || MODEL;
  const data = await anthropic({
    model: m, max_tokens: maxTokens, system,
    ...(/haiku/i.test(m) ? { thinking: { type: "disabled" } } : {}),
    tools: [tool], tool_choice: { type: "auto" },
    messages: [{ role: "user", content: user }]
  });
  if (data.stop_reason === "max_tokens") throw new Error("too_long");
  const block = (data.content || []).find(b => b.type === "tool_use");
  if (block && block.input && check(block.input)) return block.input;
  const txt = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
  if (s >= 0 && e > s) { const j = JSON.parse(txt.slice(s, e + 1)); if (check(j)) return j; }
  throw new Error("bad_shape");
}
async function tryTwice(fn, first, second) {
  try { return await fn(first || MODEL); } catch (e) { console.error("retry:", e.message); return await fn(second || FAST); }
}
function clip(s, n) { return String(s == null ? "" : s).slice(0, n); }
const ageOf = a => AGE[a] ? a : "adult";
const norm = s => String(s || "").toLowerCase().replace(/^(is it|it's|its|it is|a|an|the)\s+/g, "").replace(/^(a|an|the)\s+/, "").replace(/[^a-z0-9]/g, "");
function limited(req) {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "x";
  const now = Date.now(), hr = 3600e3;
  const list = (hits.get(ip) || []).filter(t => now - t < hr);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > HOURLY_LIMIT;
}
async function serper(q) {
  const key = String(process.env.SERPER_API_KEY || "").trim();
  if (!key) return null;
  try {
    const r = await fetch("https://google.serper.dev/search", {
      method: "POST", signal: AbortSignal.timeout(9000),
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q, num: 6, gl: "us", hl: "en" })
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
function snippetsFrom(r, max) {
  const out = [];
  if (!r) return out;
  if (r.answerBox) out.push({ title: r.answerBox.title || "Answer", link: r.answerBox.link || "", snippet: [r.answerBox.answer, r.answerBox.snippet].filter(Boolean).join(" ") });
  if (r.knowledgeGraph && r.knowledgeGraph.description) out.push({ title: r.knowledgeGraph.title || "Overview", link: r.knowledgeGraph.descriptionLink || "", snippet: r.knowledgeGraph.description });
  (r.organic || []).forEach(o => out.push({ title: o.title, link: o.link, snippet: o.snippet }));
  return out.filter(x => x.snippet).slice(0, max || 6).map(x => ({ title: clip(x.title, 100), link: clip(x.link, 300), snippet: clip(x.snippet, 400) }));
}
async function wiki(name) {
  try {
    const r = await fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(String(name).replace(/ /g, "_")), {
      signal: AbortSignal.timeout(6000), headers: { "user-agent": "TheGuessRoom/1.0 (NuSpark educational game)" }
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.extract || j.type === "disambiguation") return null;
    return {
      title: j.title, extract: clip(j.extract, 1500),
      link: (j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page) || "",
      image: (j.thumbnail && j.thumbnail.source) || (j.originalimage && j.originalimage.source) || null
    };
  } catch (e) { return null; }
}
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

// ---------- THE MYSTERY ----------
const IDEAS_TOOL = {
  name: "mystery_ideas",
  description: "Candidate secret answers for a guessing game.",
  input_schema: {
    type: "object",
    properties: {
      ideas: {
        type: "array", description: "12 different, well-known answers",
        items: {
          type: "object",
          properties: {
            answer: { type: "string", description: "The answer as players would say it, e.g. 'Giraffe', 'The Eiffel Tower', 'Rubik's Cube'" },
            wiki: { type: "string", description: "The exact English Wikipedia article title for it" },
            kind: { type: "string", enum: ["animal", "thing", "food", "place", "person", "event", "character", "other"] }
          },
          required: ["answer", "wiki", "kind"]
        }
      }
    },
    required: ["ideas"]
  }
};
const CLUES_TOOL = {
  name: "mystery_card",
  description: "The finished mystery card.",
  input_schema: {
    type: "object",
    properties: {
      intro: { type: "string", description: "Mr. Paul's short opener that tells the TYPE without giving it away, e.g. 'I'm thinking of an animal!' (max 12 words)" },
      clues: { type: "array", items: { type: "string" }, description: "Exactly 5 clues in first person ('I...'), from HARDEST to EASIEST. Clue 1 is tricky but fair, clue 5 almost gives it away. Each clue is one sentence, never uses the answer or any word from it." },
      aliases: { type: "array", items: { type: "string" }, description: "Other names or spellings that should count as correct (e.g. 'giraffes', 'Mount Everest' for 'Everest'). Up to 6." },
      wow: { type: "string", description: "One surprising, TRUE 'wow, who knew?' fact about the answer, taken from the research. One or two sentences." },
      source: { type: "string", description: "Where the wow fact comes from, e.g. 'Smithsonian's National Zoo' or 'Wikipedia'" },
      source_url: { type: "string", description: "The link for that source from the research, or empty" }
    },
    required: ["intro", "clues", "aliases", "wow", "source"]
  }
};
async function mystery(body) {
  const age = ageOf(body.age), A = AGE[age];
  const category = clip(body.category || "Anything", 40);
  const avoid = (Array.isArray(body.avoid) ? body.avoid : []).map(x => clip(x, 60)).slice(-20);
  // 1) brainstorm candidates quickly, then pick one at random (keeps games fresh)
  const ideas = await tryTwice(m => callTool(
    `You pick secret answers for "The Guess Room", a guessing game for ${A.who}. ${SAFE} ${age === "junior" ? "No real people at all for this age group." : "Famous people are fine only if they are historical or very widely known for their work (athletes, musicians, inventors, explorers); no politicians from the last 50 years."} Answers must be specific, famous enough that most ${A.who} have heard of them, and fun to guess. Mix easy and medium.`,
    IDEAS_TOOL, `Topic: ${category}\nAvoid these (already played): ${avoid.join(", ") || "none"}\nGive 12 varied answers.`, 1200,
    j => Array.isArray(j.ideas) && j.ideas.length >= 1, m), FAST, MODEL);
  const fresh = ideas.ideas.filter(x => x && x.answer && !avoid.some(a => norm(a) === norm(x.answer)));
  const choice = pick(fresh.length ? fresh : ideas.ideas);

  // 2) research it (Wikipedia + one web search for fun facts)
  const [w, web] = await Promise.all([wiki(choice.wiki || choice.answer), serper(`${choice.answer} fun facts${age === "junior" ? " for kids" : ""}`)]);
  const notes = [];
  if (w) notes.push({ title: "Wikipedia: " + w.title, link: w.link, snippet: w.extract });
  snippetsFrom(web, 5).forEach(s => notes.push(s));

  // 3) write the clues from the research
  const card = await tryTwice(m => callTool(
    `You are Mr. Paul, host of "The Guess Room", writing a guessing-game card for ${A.who}. ${A.style} ${SAFE}
Every clue and the wow fact must be TRUE; use the research notes and don't invent numbers. Clues are written as the mystery thing talking ("I..."). Never use the answer or any word from it in a clue or the intro.`,
    CLUES_TOOL, `SECRET ANSWER: ${choice.answer} (${choice.kind})\nTOPIC: ${category}\n\nRESEARCH NOTES:\n${notes.map((n, i) => `[${i + 1}] ${n.title} (${n.link}): ${n.snippet}`).join("\n") || "(none: use only well-known facts you are sure of)"}`,
    1400, j => Array.isArray(j.clues) && j.clues.length >= 5 && j.wow, m));

  // never let the answer slip into a clue
  const words = choice.answer.toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length > 3 && !["the", "this", "that"].includes(x));
  const clean = t => { let s = String(t); words.forEach(wd => { s = s.replace(new RegExp("\\b" + wd + "\\w*", "gi"), "____"); }); return s; };
  return {
    intro: clip(clean(card.intro), 120),
    clues: card.clues.slice(0, 5).map(c => clip(clean(c), 220)),
    answer: clip(choice.answer, 60),
    aliases: [choice.wiki, ...(card.aliases || [])].map(x => clip(x, 60)).filter(Boolean).slice(0, 8),
    kind: choice.kind,
    image: choice.kind === "person" ? null : (w && w.image) || null,   // no photos of real people
    wow: clip(card.wow, 300),
    source: clip(card.source || (w ? "Wikipedia" : ""), 80),
    source_url: clip(card.source_url || (w ? w.link : ""), 300)
  };
}

const JUDGE_TOOL = {
  name: "judge",
  description: "Mr. Paul's answer to the player's question or guess.",
  input_schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["yes", "no", "sort_of", "correct", "close", "wrong", "not_yes_no"], description: "yes/no/sort_of for a yes-or-no question; correct if they named the answer (or an accepted alias); close if their guess is very near (same family, misspelled-but-different); wrong for a wrong guess; not_yes_no if it can't be answered with yes or no" },
      say: { type: "string", description: "Mr. Paul's short spoken reply (max 20 words). Fun and in character. NEVER reveals or hints at the answer's name unless the verdict is correct." }
    },
    required: ["verdict", "say"]
  }
};
async function ask(body) {
  const age = ageOf(body.age), A = AGE[age];
  const answer = clip(body.answer, 60), q = clip(body.question, 160).trim();
  const aliases = (Array.isArray(body.aliases) ? body.aliases : []).map(x => clip(x, 60));
  if (!answer || !q) return { verdict: "not_yes_no", say: "Ask me a yes or no question, or take a guess!" };
  // a plain guess that matches the answer is correct without asking the AI
  const g = norm(q.replace(/\?$/, ""));
  if ([answer, ...aliases].some(a => norm(a) && norm(a) === g)) return { verdict: "correct", say: age === "junior" ? `YES! You got it! The answer is ${answer}!` : `That's it! The answer is ${answer}!` };
  const hist = (Array.isArray(body.history) ? body.history : []).slice(-8).map(h => `Q: ${clip(h.q, 120)} -> ${clip(h.a, 20)}`).join("\n");
  const out = await tryTwice(m => callTool(
    `You are Mr. Paul, host of "The Guess Room", a guessing game for ${A.who}. ${A.style}
The secret answer is "${answer}" (also accepted: ${aliases.join(", ") || "none"}). Clues the player has seen: ${(body.clues || []).map(c => clip(c, 200)).join(" | ")}
Judge the player's message HONESTLY and accurately:
- If they named the answer (any accepted name, a plural, a small misspelling, or "is it a ___?" with the right thing), verdict "correct".
- If it's a yes-or-no question, answer it truthfully about the secret: "yes", "no", or "sort_of" (when partly true or it depends).
- If it's a wrong guess, "wrong" (or "close" if very near, like the right family of animals).
- Never say the answer's name or spell it out unless the verdict is "correct". Keep "say" short and fun.`,
    JUDGE_TOOL, `${hist ? "EARLIER:\n" + hist + "\n\n" : ""}PLAYER: "${q}"`, 300,
    j => JUDGE_TOOL.input_schema.properties.verdict.enum.includes(j.verdict) && typeof j.say === "string", m), FAST, MODEL);
  let say = clip(out.say, 200);
  if (out.verdict !== "correct") { const wd = answer.toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length > 3); wd.forEach(x => { say = say.replace(new RegExp("\\b" + x + "\\w*", "gi"), "that"); }); }
  return { verdict: out.verdict, say };
}

// ---------- FACT OR FICTION ----------
const BRAIN_TOOL = {
  name: "claim_ideas",
  description: "Draft claims for Fact or Fiction.",
  input_schema: {
    type: "object",
    properties: {
      claims: {
        type: "array",
        items: {
          type: "object",
          properties: {
            claim: { type: "string", description: "One clear sentence stated as if true (max 22 words)" },
            fact: { type: "boolean", description: "true if the claim is TRUE, false if it is FICTION" },
            search: { type: "string", description: "A short web search that would confirm or debunk it" }
          },
          required: ["claim", "fact", "search"]
        }
      }
    },
    required: ["claims"]
  }
};
const CHECK_TOOL = {
  name: "checked_claims",
  description: "Claims checked against the research, with explanations.",
  input_schema: {
    type: "object",
    properties: {
      claims: {
        type: "array",
        items: {
          type: "object",
          properties: {
            i: { type: "integer", description: "The claim's number from the list" },
            keep: { type: "boolean", description: "false if the research doesn't clearly settle it, so the claim should be dropped" },
            claim: { type: "string", description: "The claim, reworded slightly only if needed to make it clearly true or clearly false" },
            fact: { type: "boolean", description: "What the RESEARCH shows: true = fact, false = fiction" },
            explain: { type: "string", description: "Two sentences: what's really true, with a specific detail from the research" },
            say: { type: "string", description: "What Mr. Paul says out loud for the reveal, starting with 'It's a fact!' or 'It's fiction!' (max 30 words)" },
            source: { type: "string", description: "The name of the best source from the research, e.g. 'NASA' or 'National Geographic'" },
            source_url: { type: "string", description: "That source's link from the research" },
            proof_kind: { type: "string", enum: ["none", "bars", "points"], description: "bars only when the research gives 2-5 comparable numbers; points for 2-3 short proof statements; else none" },
            proof_title: { type: "string" },
            proof_rows: {
              type: "array",
              items: { type: "object", properties: { label: { type: "string" }, value: { type: "number" }, unit: { type: "string" }, text: { type: "string" } } },
              description: "bars: label + value (+ unit); points: text only. Numbers must appear in the research."
            }
          },
          required: ["i", "keep", "claim", "fact", "explain", "say", "source"]
        }
      }
    },
    required: ["claims"]
  }
};
async function facts(body) {
  const age = ageOf(body.age), A = AGE[age];
  const category = clip(body.category || "Anything", 40);
  const n = Math.max(1, Math.min(6, parseInt(body.count) || 5));
  const avoid = (Array.isArray(body.avoid) ? body.avoid : []).map(x => clip(x, 160)).slice(-30);
  const want = n + 2; // draft a couple extra in case research drops some
  const draft = await tryTwice(m => callTool(
    `You write claims for "Fact or Fiction" in "The Guess Room", a game for ${A.who}. ${A.style} ${SAFE}
Mix about half TRUE facts that sound surprising and half FICTION that sounds believable (popular myths, or a real fact with one key detail changed). Each claim must be clearly true or clearly false, checkable on the web, and interesting. No trick wording.`,
    BRAIN_TOOL, `Topic: ${category}\nWrite ${want} claims.\nDon't repeat these: ${avoid.join(" | ") || "none"}`, 1600,
    j => Array.isArray(j.claims) && j.claims.length >= 2, m));
  const list = draft.claims.filter(c => c && c.claim).slice(0, want);

  const researched = await Promise.all(list.map(c => serper(clip(c.search || c.claim, 120))));
  const haveWeb = researched.some(Boolean);
  const notes = list.map((c, i) => `#${i + 1} CLAIM: ${c.claim} (writer thinks: ${c.fact ? "FACT" : "FICTION"})\n${snippetsFrom(researched[i], 5).map(s => `  - ${s.title} (${s.link}): ${s.snippet}`).join("\n") || "  (no research found)"}`).join("\n\n");

  const checked = await tryTwice(m => callTool(
    `You fact-check claims for a family game for ${A.who}. ${A.style}
For each claim decide from the RESEARCH whether it is a fact or fiction. The research wins over the writer's guess. If the research doesn't clearly settle a claim, set keep=false. ${haveWeb ? "" : "No web research is available: keep only claims you are completely certain about, and name a well-known source type (e.g. 'NASA', 'Encyclopaedia Britannica') with no link."}
Explanations and proof must use only facts from the research.`,
    CHECK_TOOL, notes, 3500, j => Array.isArray(j.claims), m));

  const out = [];
  for (const c of checked.claims) {
    if (!c || !c.keep || !c.claim || out.length >= n) continue;
    const rows = Array.isArray(c.proof_rows) ? c.proof_rows.slice(0, 5) : [];
    let proof = { kind: "none" };
    if (c.proof_kind === "bars") {
      const r = rows.filter(x => x && x.label && typeof x.value === "number" && isFinite(x.value)).map(x => ({ label: clip(x.label, 30), value: x.value, unit: clip(x.unit, 12) }));
      if (r.length >= 2) proof = { kind: "bars", title: clip(c.proof_title, 60), rows: r };
    } else if (c.proof_kind === "points") {
      const r = rows.filter(x => x && (x.text || x.label)).map(x => ({ text: clip(x.text || x.label, 180) }));
      if (r.length) proof = { kind: "points", title: clip(c.proof_title, 60), rows: r.slice(0, 3) };
    }
    out.push({
      claim: clip(c.claim, 220), fact: !!c.fact,
      explain: clip(c.explain, 400), say: clip(c.say, 260),
      source: clip(c.source, 80), source_url: haveWeb ? clip(c.source_url, 300) : "",
      proof
    });
  }
  return { claims: out, researched: haveWeb };
}

// ---------- handler ----------
module.exports = async (req, res) => {
  if (!allowedRequest(req)) return blockRequest(res);
  if (req.method === "GET") {
    return res.json({ ok: true, anthropic_key_set: !!process.env.ANTHROPIC_API_KEY, serper_key_set: !!String(process.env.SERPER_API_KEY || "").trim(), model: MODEL, fast_model: FAST });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "missing_key", message: "The game isn't set up yet." });
  if (limited(req)) return res.status(429).json({ error: "slow_down", message: "Wow, that's a lot of guessing! Take a short break and come back soon." });
  const body = req.body || {};
  try {
    if (body.part === "mystery") return res.json(await mystery(body));
    if (body.part === "ask") return res.json(await ask(body));
    if (body.part === "facts") return res.json(await facts(body));
    return res.status(400).json({ error: "unknown_part" });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: "failed", message: "Mr. Paul lost his place. Please try again." });
  }
};

// ---------- website lock ----------
// Only answer this tool's own pages and Paul's websites, so nobody else can run the tool on his credits.
// Add more sites in Vercel with an ALLOWED_SITES setting (comma separated); set LOCK_OFF to 1 to switch the lock off.
function allowedRequest(req) {
  if (String(process.env.LOCK_OFF || "") === "1") return true;
  const sites = ["nusparkpublishing.com", "nusparkmarketing.com", "nusparklearnwow.com"]
    .concat(String(process.env.ALLOWED_SITES || "").split(",").map(s => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean));
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").toLowerCase().split(":")[0];
  const ok = u => {
    try {
      const h = new URL(u).hostname.toLowerCase();
      return h === host || h === "localhost" || h === "127.0.0.1" || sites.some(d => h === d || h.endsWith("." + d));
    } catch (e) { return false; }
  };
  const origin = req.headers.origin, ref = req.headers.referer || req.headers.referrer;
  if (origin && origin !== "null") return ok(origin);
  if (ref) return ok(ref);
  return req.method === "GET"; // quick status checks; browsers always say where a POST comes from
}
function blockRequest(res) {
  res.statusCode = 403;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "not_allowed", message: "This tool only works on NuSpark websites." }));
}
