import {
  Baby, Bandage, Blocks, CircleDashed, CircleEllipsis, CloudRain, Droplets,
  Footprints, Frown, Heart, Meh, Milk, Moon, Pill, Ruler, Scale, ShowerHead,
  Smile, Star, Stethoscope, Syringe, Thermometer, Utensils,
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
