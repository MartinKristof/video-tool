#!/usr/bin/env python
"""
Word-level forced alignment for the RUN SF promo voice-over.

Whisper's DTW word timestamps were not accurate enough here: large-v3 and medium.en
disagreed by 120-580ms on every word, and large-v3 landed ~500ms before the measured
audio onset at sentence starts. So instead of trusting a transcript model's timings,
this does CTC forced alignment (wav2vec2) of the KNOWN transcript against the audio.
Frame resolution is 20ms - half a video frame at 25fps.

Ground truth check: the 5 sentence-start words are preceded by real silence, so their
onsets can be measured directly from the energy envelope. Those 5 points validate the
aligner everywhere else.

Run with:  ~/.local/pipx/venvs/openai-whisper/bin/python scripts/align-run-sf-vo.py
"""
import json, subprocess
import numpy as np
import torch, torchaudio

AUDIO = "/Volumes/T7 Shield/Run_SF_Promo/Audio/Voice-Overs.wav"
OUT = "/Users/filip/video-tool/data/run-sf/word-timings.json"
SR = 16000
FPS = 25

# The five sentences, as they appear in the artwork (verified glyph-for-glyph).
SENTENCES = [
    ["ALL", "MY", "LEAD", "GENERATION", "RUN", "THERE"],
    ["MY", "PRICE", "MONITOR", "RUNS", "THERE"],
    ["MY", "AI", "AGENTS", "RUN", "THERE"],
    ["MY", "COMPETITOR", "RESEARCH", "RUNS", "THERE"],
    ["MY", "COMPANY'S", "BRAIN", "RUNS", "THERE"],
]
WORDS = [w for s in SENTENCES for w in s]


def load_audio():
    raw = subprocess.run(
        ["ffmpeg", "-v", "quiet", "-i", AUDIO, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True).stdout
    x = np.frombuffer(raw, dtype=np.float32).copy()
    return torch.from_numpy(x).unsqueeze(0), len(x) / SR


def envelope(wave):
    """RMS at 1ms hop, dB relative to peak."""
    x = wave[0].numpy().astype(np.float64)
    hop, win = int(SR * 0.001), int(SR * 0.010)
    n = (len(x) - win) // hop
    sq = np.cumsum(np.concatenate([[0.0], x ** 2]))
    idx = np.arange(n) * hop
    rms = np.sqrt(np.maximum((sq[idx + win] - sq[idx]) / win, 1e-20))
    db = 20 * np.log10(rms)
    return db - db.max()


def measured_onset(db, t, floor_db=-42.0, hold_ms=25, back_ms=500):
    """First sustained rise above the floor, searching forward from silence before t.
    Only meaningful for words preceded by real silence."""
    i = int(t * 1000)
    lo = max(0, i - back_ms)
    hi = min(len(db), i + 200)
    seg = db[lo:hi]
    for j in range(len(seg) - hold_ms):
        if seg[j] > floor_db and np.mean(seg[j:j + hold_ms]) > floor_db - 3:
            return (lo + j) / 1000.0
    return None


def refine_onset(db, t, back_ms=95, quiet_db=-32.0, hold_ms=20):
    """Pull a CTC start back to the true acoustic onset.

    CTC tokens fire at the PEAK of acoustic evidence, so a word start is always at or
    after the real onset - never before. How late depends on the first phoneme: a
    plosive burst is crisp (~10ms), a vowel or nasal has no landmark (~75ms).

    Two cases, both searching only backwards:
      1. real silence just before the word (sentence start, or a stop closure) ->
         take the first sustained rise out of that silence.
      2. continuous speech -> take the nearest local energy minimum, which is where
         a human editor would cut the boundary.
    Returns (onset_seconds, method).
    """
    i = int(round(t * 1000))
    lo = max(0, i - back_ms)
    if lo >= i:
        return t, "none"
    win = db[lo:i + 1]

    quiet = np.where(win <= quiet_db)[0]
    if len(quiet):
        k = quiet[-1]  # last quiet sample before the word
        for j in range(k, len(win) - 1):
            if win[j] > quiet_db and np.mean(db[lo + j:lo + j + hold_ms]) > quiet_db:
                return (lo + j) / 1000.0, "silence"
        return (lo + k) / 1000.0, "silence"

    sm = np.convolve(win, np.ones(9) / 9, mode="same")  # 9ms smoothing
    return (lo + int(np.argmin(sm[:-2]))) / 1000.0, "dip"


def main():
    wave, dur = load_audio()
    db = envelope(wave)

    bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
    model = bundle.get_model()
    labels = bundle.get_labels()
    lut = {c: i for i, c in enumerate(labels)}

    with torch.inference_mode():
        emission, _ = model(wave)
        emission = torch.log_softmax(emission, dim=-1)

    tokens, lengths = [], []
    for w in WORDS:
        ids = [lut[c] for c in w if c in lut]
        assert len(ids) == len(w), f"unmapped chars in {w}"
        tokens += ids
        lengths.append(len(ids))

    aligned, scores = torchaudio.functional.forced_align(
        emission, torch.tensor([tokens], dtype=torch.int32), blank=0)
    spans = torchaudio.functional.merge_tokens(aligned[0], scores[0].exp())
    assert len(spans) == len(tokens), f"{len(spans)} spans vs {len(tokens)} tokens"

    ratio = wave.size(1) / emission.size(1) / SR  # frames -> seconds

    rows, k = [], 0
    for si, sentence in enumerate(SENTENCES):
        for wi, word in enumerate(sentence):
            grp = spans[k:k + lengths[len(rows)]]
            k += lengths[len(rows)]
            start = grp[0].start * ratio
            end = grp[-1].end * ratio
            conf = float(np.mean([s.score for s in grp]))
            onset, how = refine_onset(db, start)
            rows.append({
                "i": len(rows), "block": si, "wordInBlock": wi, "text": word,
                "ctcStart": round(start, 4),
                "start": round(onset, 4), "end": round(end, 4),
                "refinedBy": how, "refineMs": round((onset - start) * 1000, 1),
                "confidence": round(conf, 3),
                "frame": int(onset * FPS),  # floor: never late
            })

    # Validate against directly measured onsets at the 5 sentence starts.
    print(f"audio {dur:.3f}s | emission {emission.size(1)} frames | {ratio*1000:.1f} ms/frame\n")
    print("GROUND-TRUTH CHECK (sentence starts, measured from the energy envelope):")
    worst = 0.0
    for r in rows:
        if r["wordInBlock"] != 0:
            continue
        m = measured_onset(db, r["ctcStart"])
        if m is None:
            continue
        d = (r["start"] - m) * 1000
        worst = max(worst, abs(d))
        print(f"  block {r['block']}  {r['text']:<10} aligned {r['start']:6.3f}   measured {m:6.3f}   Δ {d:+6.1f} ms")
    print(f"  worst deviation: {worst:.1f} ms  ({worst/40:.2f} frames at 25fps)\n")

    sentence_ends = [max(r["end"] for r in rows if r["block"] == b) for b in range(len(SENTENCES))]
    json.dump({
        "audio": AUDIO, "audioDuration": dur, "fps": FPS,
        "method": "wav2vec2 CTC forced alignment (WAV2VEC2_ASR_BASE_960H)",
        "frameResolutionMs": round(ratio * 1000, 2),
        "groundTruthWorstDeviationMs": round(worst, 1),
        "sentenceEnds": [round(t, 4) for t in sentence_ends],
        "words": rows,
    }, open(OUT, "w"), indent=2)

    print(f"{'#':>3} {'word':<12}{'ctc':>8}{'onset':>8}{'shift':>8}{'how':>9}{'frame':>7}{'t@frame':>9}{'err':>7}{'conf':>7}")
    for r in rows:
        if r["wordInBlock"] == 0:
            print(f"  --- sentence {r['block'] + 1} ---")
        ft = r["frame"] / FPS
        print(f"{r['i']:>3} {r['text']:<12}{r['ctcStart']:8.3f}{r['start']:8.3f}"
              f"{r['refineMs']:8.0f}{r['refinedBy']:>9}{r['frame']:7d}{ft:9.3f}"
              f"{(ft - r['start']) * 1000:7.0f}{r['confidence']:7.2f}")
    print("\n  shift = ms pulled back from the CTC peak to the acoustic onset")
    print("  err   = ms the rendered frame lands relative to the onset (negative = early, never late)")
    print(f"\nsentence ends: {[round(t,3) for t in sentence_ends]}")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
