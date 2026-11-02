"""Original 30-second synthwave track for the Kelpbook video (no samples, all synthesized)."""
import wave
import numpy as np

SR = 44100
DUR = 30.0
BEAT = 0.6  # 100 BPM
t = np.arange(int(SR * DUR)) / SR
rng = np.random.default_rng(7)
mix = np.zeros_like(t)

CHORDS = [  # (pad notes, bass root), 8 beats each
    ([220.00, 261.63, 329.63], 110.00),   # Am
    ([174.61, 220.00, 261.63], 87.31),    # F
    ([196.00, 261.63, 329.63], 130.81),   # C/G
    ([196.00, 246.94, 293.66], 98.00),    # G
]
CHORD_LEN = 8 * BEAT


def chord_at(time):
    return CHORDS[int(time // CHORD_LEN) % len(CHORDS)]


def env(x, a, d):
    """Attack/decay envelope over local time x (seconds)."""
    return np.clip(x / a, 0, 1) * np.exp(-np.maximum(x - a, 0) / d)


def saw(freq, x, harmonics, bright=1.0):
    out = np.zeros_like(x)
    for n in range(1, harmonics + 1):
        out += np.sin(2 * np.pi * freq * n * x) / n * np.exp(-n / bright)
    return out


# Pad: detuned saws, a filter that opens over the first half, one segment per chord.
for i in range(int(DUR // CHORD_LEN) + 1):
    start = i * CHORD_LEN
    notes, _ = CHORDS[i % len(CHORDS)]
    seg = (t >= start - 0.4) & (t < start + CHORD_LEN + 0.8)
    x = t[seg] - start
    bright = 1.6 + 3.2 * np.clip(t[seg] / 14, 0, 1)
    tone = sum(np.sin(2 * np.pi * f * d * n * x) / n * np.exp(-n / bright)
               for f in notes for d in (0.997, 1.003) for n in range(1, 9))
    shape = np.clip((x + 0.4) / 0.9, 0, 1) * np.clip((CHORD_LEN + 0.8 - x) / 0.9, 0, 1)
    mix[seg] += 0.055 * tone * shape

# Bass: 8th-note pulses from the logo reveal on, held notes at the very end.
for k in range(int(6.4 / (BEAT / 2)), int(DUR / (BEAT / 2))):
    st = k * BEAT / 2
    if 23.0 <= st < 25.8:
        continue
    _, root = chord_at(st)
    seg = (t >= st) & (t < st + BEAT / 2)
    x = t[seg] - st
    mix[seg] += 0.20 * saw(root, x, 6, 2.5) * env(x, 0.005, 0.16)

# Drums: kick on every beat, clap on 2 and 4, offbeat hats; out during the "humans can't post" break.
def drums_on(st):
    return 6.4 <= st < 23.0 or 25.85 <= st < 28.6

for b in range(int(DUR / BEAT)):
    st = b * BEAT
    if not drums_on(st):
        continue
    seg = (t >= st) & (t < st + 0.35)
    x = t[seg] - st
    freq = 45 + 85 * np.exp(-x / 0.035)
    mix[seg] += 0.55 * np.sin(2 * np.pi * np.cumsum(freq) / SR) * env(x, 0.002, 0.11)
    if st >= 9.4 and b % 2 == 1:
        seg = (t >= st) & (t < st + 0.2)
        x = t[seg] - st
        noise = rng.standard_normal(seg.sum())
        mix[seg] += 0.14 * (noise - np.convolve(noise, np.ones(6) / 6, 'same')) * env(x, 0.001, 0.05)
    if st >= 12.8:
        hs = st + BEAT / 2
        seg = (t >= hs) & (t < hs + 0.06)
        x = t[seg] - hs
        noise = rng.standard_normal(seg.sum())
        mix[seg] += 0.05 * (noise - np.convolve(noise, np.ones(3) / 3, 'same')) * env(x, 0.001, 0.018)

# Arpeggio: 16th notes on chord tones, an octave up, during the middle section.
for k in range(int(12.8 / (BEAT / 4)), int(23.0 / (BEAT / 4))):
    st = k * BEAT / 4
    notes, _ = chord_at(st)
    f = notes[k % 3] * 2
    seg = (t >= st) & (t < st + BEAT / 4)
    x = t[seg] - st
    mix[seg] += 0.045 * np.sign(np.sin(2 * np.pi * f * x)) * env(x, 0.003, 0.06)

# Risers into the two big moments, then impacts.
for hit in (6.45, 25.85):
    seg = (t >= hit - 1.1) & (t < hit)
    x = (t[seg] - (hit - 1.1)) / 1.1
    mix[seg] += 0.12 * rng.standard_normal(seg.sum()) * x ** 2.5
    seg = (t >= hit) & (t < hit + 1.6)
    x = t[seg] - hit
    mix[seg] += 0.7 * np.sin(2 * np.pi * (38 + 40 * np.exp(-x / 0.08)) * x) * env(x, 0.003, 0.45)
    mix[seg] += 0.18 * rng.standard_normal(seg.sum()) * env(x, 0.001, 0.12)

# Simple room: a few feedback-free echoes.
wet = np.zeros_like(mix)
for delay, gain in ((0.113, 0.28), (0.197, 0.2), (0.311, 0.14), (0.433, 0.08)):
    n = int(delay * SR)
    wet[n:] += mix[:-n] * gain
mix = mix + wet

# Fades, soft clip, normalize, slight stereo spread.
mix *= np.clip(t / 0.8, 0, 1) * np.clip((DUR - t) / 1.6, 0, 1)
mix = np.tanh(mix * 1.4)
mix /= np.max(np.abs(mix)) / 0.89
left = mix
right = np.concatenate([np.zeros(int(0.012 * SR)), mix[:-int(0.012 * SR)]])
stereo = (np.stack([left, right], axis=1) * 32767).astype(np.int16)

with wave.open('music.wav', 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(stereo.tobytes())
print('wrote music.wav', DUR, 's')
