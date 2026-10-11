import {
  Shield,
  Wrench,
  BadgeCheck,
  Cloud,
  Crosshair,
  DoorOpen,
  FileText,
  Flashlight,
  Footprints,
  Gem,
  Grid3x3,
  Hammer,
  Hand,
  KeyRound,
  LogIn,
  LogOut,
  ShoppingBag,
  Undo2,
  Package,
} from 'lucide-react';

export const ITEM_ICONS = {
  crowbar: Wrench,
  shield: Shield,
  grabber: Hand,
  sack: ShoppingBag,
  light: Flashlight,
  wedge: DoorOpen,
  pick: KeyRound,
  replica: Gem,
  paper: FileText,
  pistol: Crosshair,
  smoke: Cloud,
};

const ACTION_ICONS = {
  enter: LogIn,
  keypad: Grid3x3,
  strike: Hammer,
  take: Package,
  return: Undo2,
  leave: LogOut,
  run: Footprints,
  walk: Footprints,
  pass: BadgeCheck,
  hand: Hand,
};

export const actionIcon = (key) => ACTION_ICONS[key] || ITEM_ICONS[key] || Hand;
