'use client';

import { useTheme } from '@/components/ThemeProvider';
import { Card, Button } from '@/components/ui';
import { PRESETS, channelsToHex, hexToChannels, type Appearance } from '@/lib/theme';

const APPEARANCES: Appearance[] = ['light', 'dark', 'system'];

export default function ThemeSettingsPage() {
  const { theme, setPreset, setPrimary, setRadius, setAppearance } = useTheme();

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-black">Theme</h1>
        <p className="text-muted text-xs mt-1">
          Changes apply live across every screen. Saved in this browser — per-organisation
          persistence needs a settings table (not built yet).
        </p>
      </div>

      <Card>
        <h2 className="font-bold text-sm mb-3">Preset</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {Object.entries(PRESETS).map(([name, tokens]) => (
            <button
              key={name}
              onClick={() => setPreset(name)}
              className={`rounded-lg border p-3 text-left ${
                theme.preset === name ? 'border-primary' : 'border-border'
              }`}
            >
              <span
                className="block w-full h-8 rounded mb-2"
                style={{ background: `rgb(${tokens.primary})` }}
              />
              <span className="text-[11px] font-semibold">{name}</span>
            </button>
          ))}
          {theme.preset === 'Custom' && (
            <div className="rounded-lg border border-primary p-3">
              <span
                className="block w-full h-8 rounded mb-2"
                style={{ background: `rgb(${theme.tokens.primary})` }}
              />
              <span className="text-[11px] font-semibold">Custom</span>
            </div>
          )}
        </div>
      </Card>

      <Card className="space-y-4">
        <h2 className="font-bold text-sm">Fine-tune</h2>

        <label className="flex items-center justify-between text-xs">
          <span className="font-semibold">Primary colour</span>
          <input
            type="color"
            value={channelsToHex(theme.tokens.primary)}
            onChange={(e) => setPrimary(hexToChannels(e.target.value))}
            className="h-8 w-14 rounded border border-border bg-surface"
          />
        </label>

        <label className="flex items-center justify-between text-xs">
          <span className="font-semibold">Corner radius — {theme.tokens.radius}</span>
          <input
            type="range"
            min={0}
            max={24}
            value={parseInt(theme.tokens.radius, 10) || 0}
            onChange={(e) => setRadius(`${e.target.value}px`)}
            className="w-48 accent-primary"
          />
        </label>

        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold">Appearance</span>
          <div className="flex gap-1.5">
            {APPEARANCES.map((a) => (
              <Button
                key={a}
                variant={theme.appearance === a ? 'primary' : 'ghost'}
                onClick={() => setAppearance(a)}
              >
                {a}
              </Button>
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="font-bold text-sm mb-3">Preview</h2>
        <div className="flex flex-wrap items-center gap-3">
          <Button>Primary button</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <span className="rounded border border-border bg-main px-3 py-1.5 text-xs">
            Surface / border sample
          </span>
          <span className="rounded-lg bg-primary text-primary-fg px-3 py-1.5 text-xs font-semibold">
            Radius {theme.tokens.radius}
          </span>
        </div>
      </Card>
    </div>
  );
}
