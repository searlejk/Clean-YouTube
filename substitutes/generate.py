"""Make example sentences for each way a swear is used (senses.json), with a
small local language model (Qwen3-4B on the Mac GPU, free and offline).

The sentences are what people say in YouTube videos and write online, each
labelled with the sense of the swear in it. They're used to check (and later
train) how the filter picks a stand-in from the words around a swear.

    companion/.venv/bin/python substitutes/generate.py --per-sense 100
    companion/.venv/bin/python substitutes/generate.py --per-sense 20 --only fuck.dismiss,shit.holy

Writes substitutes/data/sentences.jsonl (appends; re-running tops each sense
up to --per-sense). Each line: {"sense", "text", "context", "split"}.
"""

import argparse
import hashlib
import json
import random
import re
import time
from pathlib import Path

HERE = Path(__file__).parent
MODEL = "mlx-community/Qwen3-4B-Instruct-2507-4bit"
OUT = HERE / "data" / "sentences.jsonl"

# Where the speech comes from, to keep the sentences varied.
CONTEXTS = [
    "a gamer streaming a hard boss fight", "a gamer losing an online match", "a cooking show chef in the kitchen",
    "friends reacting to a viral video", "a sports fan watching a close game", "a podcast host telling a story",
    "a car reviewer test-driving a car", "a prank video", "a daily vlogger", "a fitness coach at the gym",
    "a tech reviewer unboxing a phone", "a horror game streamer getting scared", "two friends fishing",
    "a DIY home repair video", "a comedy sketch", "a Reddit comment", "a reply on Twitter/X", "a travel vlogger",
    "a skateboarder filming tricks", "a mechanic fixing a truck", "roommates arguing", "a stand-up comedian",
    "a YouTube commenter", "a coworker venting after work", "a music producer in the studio",
    "a hiker on a tough trail", "a poker player", "a dad doing yard work", "a college student studying for finals",
    "a TikTok storytime", "a true-crime podcast", "a basketball pickup game", "someone moving apartments",
]

ROOTS = {  # sense id prefix -> what must appear in the sentence
    "fuck": r"fuck", "motherfucker": r"motherfuck", "shit": r"shit", "shitty": r"shitty", "damn": r"damn",
    "hell": r"(?<![a-z])hell(?![a-z])", "bitch": r"bitch", "dick": r"dick(?!ens)", "piss": r"piss",
    "bastard": r"bastard",
    "ass": r"(?<![a-z])(ass|asses|asshole\w*|dumbass\w*|jackass\w*|badass\w*|kickass\w*|half-?ass\w*|\w+-ass\w*)(?![a-z])",
}

SYSTEM = (
    "You write realistic training data for a profanity filter that replaces swear words with clean ones. "
    "Write exactly what real people say out loud or type online: casual, natural, with swearing left uncensored."
)


STYLES = [
    "short reactions of 3 to 6 words", "longer rambling sentences of 12 to 20 words, like spoken speech",
    "a mix of questions and statements", "lines that start with filler like 'bro', 'dude', 'okay so', 'like', 'honestly'",
    "lines where the swear comes near the end", "lines where the swear comes in the middle",
    "lines with no punctuation at all, like an auto-generated transcript", "lines addressed to another person",
    "lines that tell a tiny story", "lines with slang and typos, like a comment section",
]


def prompt_for(sense, context, n, style):
    ex = "; ".join(f'"{e}"' for e in sense["examples"])
    return (
        f"Write {n} different things {context} might say, each using the swear word \"{sense['swear']}\" "
        f"(or a form of it) with this meaning: {sense['meaning']}.\n"
        f"Examples of this meaning: {ex}.\n"
        f"Style: {style}. Every line must be built differently from the others (no shared opening or ending).\n"
        "Rules: one per line; no numbering, quotes or explanations; do not reuse the examples; every line "
        "must contain the swear with exactly that meaning."
    )


def check_prompt(root_senses, swear, lines):
    opts = "\n".join(f"{chr(65 + k)}) {s['meaning']} (e.g. \"{s['examples'][0]}\")" for k, s in enumerate(root_senses))
    body = "\n".join(f"{k + 1}. {l}" for k, l in enumerate(lines))
    return (
        f"In each sentence below, what does the swear word (a form of \"{swear}\") mean?\n{opts}\n\n{body}\n\n"
        "Answer with one line per sentence, like \"1. B\", and nothing else."
    )


def clean_line(line):
    line = re.sub(r"^\s*(\d+[.)]|[-*•])\s*", "", line).strip().strip('"“”').strip()
    line = line.replace("*", "")
    return line


def split_for(text):
    """Stable train/validation split (15% validation) from the sentence itself."""
    h = int(hashlib.sha1(text.lower().encode()).hexdigest(), 16)
    return "val" if h % 100 < 15 else "train"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-sense", type=int, default=100)
    ap.add_argument("--batch", type=int, default=8, help="sentences asked for per model call")
    ap.add_argument("--only", default="", help="comma-separated sense ids")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    from mlx_lm import generate, load
    from mlx_lm.sample_utils import make_sampler

    senses = json.loads((HERE / "senses.json").read_text())["senses"]
    all_senses = list(senses)
    if args.only:
        keep = set(args.only.split(","))
        senses = [s for s in senses if s["id"] in keep]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    have, seen = {}, set()
    if OUT.exists():
        for line in OUT.read_text().splitlines():
            r = json.loads(line)
            have[r["sense"]] = have.get(r["sense"], 0) + 1
            seen.add(r["text"].lower())

    model, tok = load(MODEL)
    sampler = make_sampler(temp=0.9, top_p=0.95)
    greedy = make_sampler(temp=0.0)
    dropped = 0
    rng = random.Random(args.seed)
    t_all, made = time.time(), 0
    with OUT.open("a") as f:
        for s in senses:
            root = re.compile(ROOTS[s["id"].split(".")[0]], re.I)
            prefix = s["id"].split(".")[0]
            family = [x for x in all_senses if x["id"].split(".")[0] == prefix]
            rounds = 0
            while have.get(s["id"], 0) < args.per_sense and rounds < 6 * args.per_sense // args.batch + 4:
                rounds += 1
                ctx, style = rng.choice(CONTEXTS), rng.choice(STYLES)
                p = tok.apply_chat_template([{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt_for(s, ctx, args.batch, style)}], add_generation_prompt=True)
                text = generate(model, tok, prompt=p, max_tokens=40 * args.batch, sampler=sampler)
                lines = []
                for line in text.splitlines():
                    line = clean_line(line)
                    if 2 <= len(line.split()) <= 25 and root.search(line) and line.lower() not in seen and line not in lines:
                        lines.append(line)
                if len(family) > 1 and lines:
                    # Second opinion: the model picks the meaning of each line from
                    # this sense and up to 3 others (shuffled); keep the ones it agrees on.
                    opts = [s] + rng.sample([x for x in family if x is not s], min(3, len(family) - 1))
                    rng.shuffle(opts)
                    want = chr(65 + opts.index(s))
                    cp = tok.apply_chat_template([{"role": "user", "content": check_prompt(opts, s["swear"], lines)}], add_generation_prompt=True)
                    ans = generate(model, tok, prompt=cp, max_tokens=6 * len(lines) + 8, sampler=greedy)
                    got = dict(re.findall(r"(\d+)\W+([A-Z])", ans))
                    kept = [l for k, l in enumerate(lines) if got.get(str(k + 1)) == want]
                    dropped += len(lines) - len(kept)
                    lines = kept
                for line in lines:
                    if have.get(s["id"], 0) >= args.per_sense:
                        break
                    seen.add(line.lower())
                    f.write(json.dumps({"sense": s["id"], "text": line, "context": ctx, "split": split_for(line)}) + "\n")
                    have[s["id"]] = have.get(s["id"], 0) + 1
                    made += 1
                f.flush()
            print(f"{s['id']:24s} {have.get(s['id'], 0):4d}   ({made} new, {dropped} dropped, {time.time() - t_all:.0f} s)", flush=True)


if __name__ == "__main__":
    main()
