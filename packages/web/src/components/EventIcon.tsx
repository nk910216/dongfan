import {
  Baby, Bandage, Blocks, CircleDashed, CircleEllipsis, CloudRain, Droplets,
  Footprints, Frown, Heart, Meh, Milk, Moon, Pill, Ruler, Scale, ShowerHead,
  Smile, Star, Stethoscope, Syringe, Thermometer, TriangleAlert, Utensils,
  type LucideIcon,
} from 'lucide-react';

/**
 * Maps a config icon name to its component.
 *
 * An unknown id renders a neutral placeholder rather than throwing, because
 * a client can be older than the config it is given (spec 3.1).
 */
const ICONS: Record<string, LucideIcon> = {
  heart: Heart,
  milk: Milk,
  utensils: Utensils,
  droplets: Droplets,
  baby: Baby,
  moon: Moon,
  footprints: Footprints,
  'shower-head': ShowerHead,
  blocks: Blocks,
  scale: Scale,
  ruler: Ruler,
  'circle-dashed': CircleDashed,
  stethoscope: Stethoscope,
  syringe: Syringe,
  thermometer: Thermometer,
  bandage: Bandage,
  'triangle-alert': TriangleAlert,
  pill: Pill,
  smile: Smile,
  meh: Meh,
  frown: Frown,
  'cloud-rain': CloudRain,
  star: Star,
  'circle-ellipsis': CircleEllipsis,
};

export const FALLBACK_COLOR = '#9A9086';

type Props = { icon: string; color: string; size?: number };

export function EventIcon({ icon, color, size = 20 }: Props): React.JSX.Element {
  const Icon = ICONS[icon] ?? CircleEllipsis;
  return <Icon size={size} color={color} strokeWidth={1.8} aria-hidden />;
}

type BadgeProps = Props & { diameter?: number };

/** The tinted circle an event icon sits in, used in lists and grids. */
export function EventIconBadge({ icon, color, size = 20, diameter = 38 }: BadgeProps): React.JSX.Element {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full"
      style={{ width: diameter, height: diameter, backgroundColor: `${color}26` }}
    >
      <EventIcon icon={icon} color={color} size={size} />
    </span>
  );
}

type ChipProps = { icon: string; color: string; size?: number };

/**
 * The type's colour as a solid block, with the glyph knocked out of it.
 *
 * The strongest signal available for *which* type, and it costs four hundred
 * square pixels rather than a whole card -- which is why it is the last
 * thing a narrowing card drops (docs/timeline-design.md).
 *
 * It has to carry that load because the palette cannot: five of the
 * twenty-three colours are near-identical teals and four are near-identical
 * purples, so colour identifies a family and the glyph identifies the type.
 */
export function EventIconChip({ icon, color, size = 20 }: ChipProps): React.JSX.Element {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[6px]"
      style={{ width: size, height: size, backgroundColor: color }}
    >
      <Icon icon={icon} size={Math.round(size * 0.65)} />
    </span>
  );
}

/** The glyph alone, in the ground colour, for knocking out of a block. */
function Icon({ icon, size }: { icon: string; size: number }): React.JSX.Element {
  const Glyph = ICONS[icon] ?? CircleEllipsis;
  return <Glyph size={size} color="var(--color-ground)" strokeWidth={2.2} aria-hidden />;
}
