#!/usr/bin/env python3
"""Time tracker for the Clean YouTube project.

Logs when you send Claude a message and when Claude finishes replying, and
turns that into time spent:

  * Claude working:  from your message until Claude's reply is finished.
  * You:             the gap until your next message. Gaps up to
                     AUTO_GAP_MINUTES count automatically (reading, typing,
                     trying things). Longer gaps are only counted once you say
                     how much of them you spent on the project.

Commands
  prompt                  UserPromptSubmit hook: log your message (reads hook JSON on stdin)
  stop                    Stop hook: log that Claude finished (reads hook JSON on stdin)
  answer MINUTES [--gap N]  record how many minutes of a long gap you worked
                          (default: the most recent unanswered gap; N from `report`)
  report                  print totals per day and list unanswered gaps
  backfill TRANSCRIPT     rebuild a past session from a Claude Code transcript (.jsonl);
                          safe to re-run, it replaces that session's backfilled events
"""
import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG = os.environ.get('TIMELOG_FILE') or os.path.join(ROOT, 'time-log.jsonl')
AUTO_GAP_MINUTES = 10


def now():
    return datetime.now(timezone.utc)


def parse(ts):
    return datetime.fromisoformat(ts.replace('Z', '+00:00'))


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec='seconds')


def local(dt):
    return dt.astimezone().strftime('%a %b %-d, %-I:%M %p')


def load():
    if not os.path.exists(LOG):
        return []
    events = []
    with open(LOG) as f:
        for line in f:
            line = line.strip()
            if line:
                events.append(json.loads(line))
    return events


def append(event):
    with open(LOG, 'a') as f:
        f.write(json.dumps(event) + '\n')


def save(events):
    events.sort(key=lambda e: e['ts'])
    with open(LOG, 'w') as f:
        for e in events:
            f.write(json.dumps(e) + '\n')


def read_hook_input():
    try:
        return json.load(sys.stdin)
    except Exception:
        return {}


def timeline(events, at=None):
    """Turn prompt/stop events into Claude-working intervals and gaps."""
    marks = sorted((parse(e['ts']), e['event']) for e in events if e['event'] in ('prompt', 'stop'))
    prompts = [t for t, kind in marks if kind == 'prompt']
    stops = [t for t, kind in marks if kind == 'stop']
    answers = {e['gap_end']: e['minutes'] for e in events if e['event'] == 'answer'}
    at = at or now()

    turns, gaps = [], []
    for i, p in enumerate(prompts):
        nxt = prompts[i + 1] if i + 1 < len(prompts) else None
        done = [s for s in stops if s >= p and (nxt is None or s < nxt)]
        if done:
            end, finished = max(done), True
        else:
            # Interrupted by a new message, or still working right now.
            end, finished = (nxt or at), nxt is not None
        turns.append({'start': p, 'end': end, 'finished': finished})
        if nxt is not None:
            gap_min = max(0.0, (nxt - end).total_seconds() / 60)
            key = iso(nxt)
            if gap_min <= AUTO_GAP_MINUTES:
                gaps.append({'start': end, 'end': nxt, 'minutes': gap_min, 'worked': gap_min, 'status': 'auto'})
            elif key in answers:
                worked = min(float(answers[key]), gap_min)
                gaps.append({'start': end, 'end': nxt, 'minutes': gap_min, 'worked': worked, 'status': 'answered'})
            else:
                gaps.append({'start': end, 'end': nxt, 'minutes': gap_min, 'worked': 0.0, 'status': 'pending'})
    return turns, gaps


def fmt(minutes):
    h, m = divmod(int(round(minutes)), 60)
    return f'{h} h {m:02d} min' if h else f'{m} min'


def cmd_prompt(_args):
    data = read_hook_input()
    t = now()
    append({'ts': iso(t), 'event': 'prompt', 'session': data.get('session_id'), 'source': 'hook'})
    _, gaps = timeline(load(), at=t)
    gap = gaps[-1] if gaps and gaps[-1]['end'] == parse(iso(t)) else None
    if gap and gap['status'] == 'pending':
        context = (
            f"Time tracker: {fmt(gap['minutes'])} passed between Claude's last reply "
            f"({local(gap['start'])}) and this message. Before or alongside answering, ask the user "
            "how many of those minutes they spent working on the Clean YouTube project "
            "(testing, reading, planning). Then record it with: "
            "python3 tools/timelog.py answer MINUTES"
        )
        print(json.dumps({'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': context}}))


def cmd_stop(_args):
    data = read_hook_input()
    append({'ts': iso(now()), 'event': 'stop', 'session': data.get('session_id'), 'source': 'hook'})


def cmd_answer(args):
    events = load()
    _, gaps = timeline(events)
    pending = [g for g in gaps if g['status'] != 'auto']
    if not pending:
        sys.exit('No long gaps to answer.')
    if args.gap is not None:
        if not 1 <= args.gap <= len(pending):
            sys.exit(f'--gap must be between 1 and {len(pending)} (see `report`).')
        gap = pending[args.gap - 1]
    else:
        unanswered = [g for g in pending if g['status'] == 'pending']
        if not unanswered:
            sys.exit('All long gaps are answered; pass --gap N to change one.')
        gap = unanswered[-1]
    key = iso(gap['end'])
    events = [e for e in events if not (e['event'] == 'answer' and e['gap_end'] == key)]
    events.append({'ts': iso(now()), 'event': 'answer', 'gap_end': key, 'minutes': args.minutes})
    save(events)
    print(f"Recorded {fmt(min(args.minutes, gap['minutes']))} of work for the gap "
          f"{local(gap['start'])} → {local(gap['end'])}.")


def cmd_report(_args):
    turns, gaps = timeline(load())
    if not turns:
        print('No time logged yet.')
        return
    days = defaultdict(lambda: {'claude': 0.0, 'you': 0.0})
    for t in turns:
        days[t['start'].astimezone().date()]['claude'] += (t['end'] - t['start']).total_seconds() / 60
    for g in gaps:
        days[g['start'].astimezone().date()]['you'] += g['worked']

    print(f"{'Day':<16}{'Claude working':>16}{'You':>14}{'Total':>14}")
    tc = ty = 0.0
    for day in sorted(days):
        c, y = days[day]['claude'], days[day]['you']
        tc, ty = tc + c, ty + y
        print(f"{day.strftime('%a %b %-d'):<16}{fmt(c):>16}{fmt(y):>14}{fmt(c + y):>14}")
    print(f"{'All time':<16}{fmt(tc):>16}{fmt(ty):>14}{fmt(tc + ty):>14}")
    if turns and not turns[-1]['finished']:
        print('(The latest turn is still running; its time so far is included.)')

    long_gaps = [g for g in gaps if g['status'] != 'auto']
    if long_gaps:
        print(f'\nGaps longer than {AUTO_GAP_MINUTES} min (only the time you say you worked counts):')
        for i, g in enumerate(long_gaps, 1):
            state = f"you worked {fmt(g['worked'])}" if g['status'] == 'answered' else 'NOT ANSWERED YET'
            print(f"  {i}. {local(g['start'])} → {local(g['end'])}  ({fmt(g['minutes'])})  {state}")
        if any(g['status'] == 'pending' for g in long_gaps):
            print('\nAnswer with: python3 tools/timelog.py answer MINUTES --gap N')


def cmd_backfill(args):
    session, prompts, activity = None, [], []
    with open(args.transcript) as f:
        for line in f:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            session = session or d.get('sessionId')
            ts = d.get('timestamp')
            if not ts:
                continue
            if d.get('type') == 'user' and not d.get('isMeta'):
                content = d.get('message', {}).get('content')
                if isinstance(content, str) or (
                    isinstance(content, list) and content and content[0].get('type') in ('text', 'image')
                ):
                    prompts.append(parse(ts))
                    continue
            if d.get('type') in ('assistant', 'user', 'system'):
                activity.append(parse(ts))
    prompts.sort()
    activity.sort()

    events = [e for e in load() if not (e.get('source') == 'backfill' and e.get('session') == session)]
    for i, p in enumerate(prompts):
        nxt = prompts[i + 1] if i + 1 < len(prompts) else None
        last = max([a for a in activity if a >= p and (nxt is None or a < nxt)], default=p)
        events.append({'ts': iso(p), 'event': 'prompt', 'session': session, 'source': 'backfill'})
        events.append({'ts': iso(last), 'event': 'stop', 'session': session, 'source': 'backfill'})
    # Hook-logged events for the same moments would double up; keep one of each.
    seen, unique = set(), []
    for e in sorted(events, key=lambda e: (e['ts'], e.get('source') != 'hook')):
        key = (e['event'], e['ts'][:16]) if e['event'] in ('prompt', 'stop') else None
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        unique.append(e)
    save(unique)
    print(f'Backfilled {len(prompts)} messages from session {session}.')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('prompt')
    sub.add_parser('stop')
    a = sub.add_parser('answer')
    a.add_argument('minutes', type=float)
    a.add_argument('--gap', type=int)
    sub.add_parser('report')
    b = sub.add_parser('backfill')
    b.add_argument('transcript')
    args = ap.parse_args()
    {'prompt': cmd_prompt, 'stop': cmd_stop, 'answer': cmd_answer, 'report': cmd_report, 'backfill': cmd_backfill}[args.cmd](args)


if __name__ == '__main__':
    main()
