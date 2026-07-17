// Clip analyzer (doc 05 §5): in ONE Gemini pass over the whole video, find the best short-form
// moments AND write each one's post copy (hooks + per-platform captions) — merging moment-finding
// with scriptwriting. Genre-aware selection (podcast/sports/racing/comedy/stage-talk/…) encodes the
// research-backed "what to clip / how to open / how to end" playbook per genre + a safety gate.
// Runs through analyzeVideo (Gemini) with the Whisper transcript inlined (Whisper owns caption
// timing at render).

const GENRE_PLAYBOOK = `GENRE PLAYBOOK — apply the matching genre's rules to WHAT you clip, WHERE the window starts, and WHERE it ends:
- podcast / interview / long-form talking: clip hot takes, genuine disagreements/debates, a story with a full arc, vulnerable/emotional confessions, "mind-blown" reactions, and crisp quotable one-liners. START mid-sentence at the moment of peak tension (never on the setup question). Favor moments that make a viewer want to take a side or tag a friend.
- sports: clip game-deciding plays, unreal skill ("looks fake"), raw emotion (tears/celebration), controversy, and mic'd-up audio. OPEN payoff-first (show the outcome), then let it breathe.
- motorsport / racing: clip team-radio one-liners (funny or emotional), overtakes / photo-finishes, pit drama, rivalries, and driver personality. OPEN on the radio line or the move itself.
- comedy / stand-up / sketch: clip crowd-work exchanges, the single biggest laugh, and self-contained jokes with a universal theme. Keep a COMPRESSED setup then the punchline, and END ON THE LAUGH — set endSec ~2-4s AFTER the punchline lands so the crowd reaction is included. Never end before the line finishes.
- stage talk / keynote / TED / motivational: clip the one big idea stated in a sentence, a vulnerable story beat, the mic-drop line, a live demo, or a contrarian reframe. STATE THE IDEA IMMEDIATELY (delete the preamble). Preserve deliberate dramatic pauses inside the window.
- tutorial / explainer / vlog / other: clip one complete tip or insight with a clear, concrete result; front-load the outcome.`;

const SAFETY_GATE = `SAFETY GATE: do NOT select moments depicting serious injury, graphic violence, medical emergencies, or accidents whose outcome/safety is unconfirmed or distressing (e.g. a bad crash before everyone is known safe) — skip them even if dramatic.`;

/** The prompt that finds moments AND writes their copy in one Gemini call. `genre` optionally forces
 *  a genre (from the user); otherwise the model infers it from the video. */
export function clipAnalyzerPrompt(transcriptText: string, genre?: string): string {
  const genreLine = genre
    ? `The user says this video's genre is "${genre}" — trust that and apply its playbook.`
    : `FIRST infer the video's GENRE from what you see and hear (podcast/interview, sports, motorsport/racing, comedy/stand-up, stage-talk/keynote, tutorial/explainer, or vlog/other).`;

  return `You are an elite short-form video editor turning a long-form video WE OWN (or are licensed to clip) into ready-to-post VIRAL vertical clips — finding the best moments AND writing each clip's copy, in one pass.

${genreLine}

PICK 5-10 moments, ranked BEST FIRST. Every moment MUST:
- be 15-90 seconds and SELF-CONTAINED (a first-time viewer needs zero outside context to get it),
- START on a scroll-stopping hook within the first 1-2 seconds — a bold/contrarian claim, a number, a question, or a strong emotional/visual beat. Trim any slow lead-in; you MAY start the window mid-sentence at the single strongest line.
- contain its own hook → build → payoff, where the hook is a PROMISE the moment actually keeps (no bait-and-switch),
- peak emotionally or informationally INSIDE the window (not before or after it).

${GENRE_PLAYBOOK}

${SAFETY_GATE}

ALSO detect whether the video ALREADY has hardcoded / burned-in SUBTITLES or CAPTIONS — persistent on-screen text that transcribes the SPOKEN words (usually a line or two along the lower part of the frame), the kind creators hard-bake into the video. Do NOT count logos, channel names, titles / lower-thirds, meme captions, or occasional graphics. Report it as a top-level boolean "hasBurnedCaptions" (we use it to avoid burning a SECOND caption track over the source's own).

Return a JSON object { "hasBurnedCaptions": <boolean>, "moments": [ ... ] }. For EACH moment return:
- startSec, endSec — align to the transcript; put the hook at the very START of the window,
- hookScore, selfContainedScore, emotionScore (0-100) — score honestly. A tight, self-contained emotional peak that opens strong beats a longer rambling one.
- transcriptSlice: the VERBATIM words spoken in that window (≤500 chars),
- suggestedHookText: a ≤120-char on-screen hook,
- hookVariants: EXACTLY 3 distinct, punchy on-screen hook texts (ids "a","b","c", ≤120 chars each) specific to THIS moment — avoid overused templates ("wait for it", "watch till the end"),
- perPlatformCaptions: {"tiktok": {"caption": "1-2 lines", "hashtags": ["≤5 tags, no # sign"]}, "youtube": {"title": "≤100 chars", "description": "2-3 lines", "tags": ["a","few"]}}.

Base every hook and caption ONLY on what is actually said and shown in the moment — no invented facts.
The full transcript with timestamps follows — align your windows to it.

TRANSCRIPT:
${transcriptText.slice(0, 24_000)}`;
}
