import {
  Accessibility, Armchair, Award, BadgeDollarSign, Baby, BookOpen, Bot, Briefcase, Bus, Calculator, Camera, CircleParking,
  Clapperboard, ClipboardCheck, Clock, Code, Coffee, Cookie, Crown, CupSoda, Dog, FileText, Gamepad2, Gift, Globe,
  GraduationCap, HandCoins, Handshake, HeartHandshake, HeartPulse, Laptop, Leaf, Lightbulb, MapPin, Megaphone, Mic,
  MonitorPlay, MonitorSmartphone, Music, PartyPopper, PiggyBank, Pizza, Presentation, Rocket, Salad, Scale, School, Shirt,
  Ticket, TicketCheck, Trees, TrendingUp, Trophy, UserCheck, Users, Utensils, Video, Wifi, Wine, Wrench, Cpu,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * The icons an organiser can attach to an event. The stored value is the key;
 * the server accepts only the keys listed in worker/src/services/eventOptions.ts.
 */

export interface EventIcon {
  key: string;
  label: string;
  group: string;
  Icon: LucideIcon;
}

export const EVENT_ICONS: EventIcon[] = [
  { key: 'food', label: 'Food provided', group: 'Food & drink', Icon: Utensils },
  { key: 'pizza', label: 'Pizza', group: 'Food & drink', Icon: Pizza },
  { key: 'snacks', label: 'Snacks', group: 'Food & drink', Icon: Cookie },
  { key: 'coffee', label: 'Coffee', group: 'Food & drink', Icon: Coffee },
  { key: 'drinks', label: 'Drinks', group: 'Food & drink', Icon: CupSoda },
  { key: 'alcohol', label: 'Alcohol served', group: 'Food & drink', Icon: Wine },
  { key: 'vegetarian', label: 'Vegetarian options', group: 'Food & drink', Icon: Salad },

  { key: 'cash-prize', label: 'Cash prize', group: 'Prizes & money', Icon: BadgeDollarSign },
  { key: 'trophy', label: 'Competition', group: 'Prizes & money', Icon: Trophy },
  { key: 'giveaways', label: 'Giveaways', group: 'Prizes & money', Icon: Gift },
  { key: 'swag', label: 'Free swag', group: 'Prizes & money', Icon: Shirt },
  { key: 'free', label: 'Free admission', group: 'Prizes & money', Icon: TicketCheck },
  { key: 'ticket', label: 'Ticket required', group: 'Prizes & money', Icon: Ticket },
  { key: 'certificate', label: 'Certificate', group: 'Prizes & money', Icon: Award },
  { key: 'funding', label: 'Funding available', group: 'Prizes & money', Icon: PiggyBank },
  { key: 'grants', label: 'Grants', group: 'Prizes & money', Icon: HandCoins },

  { key: 'networking', label: 'Networking', group: 'Format', Icon: Handshake },
  { key: 'speaker', label: 'Guest speaker', group: 'Format', Icon: Mic },
  { key: 'panel', label: 'Panel', group: 'Format', Icon: Users },
  { key: 'workshop', label: 'Workshop', group: 'Format', Icon: Wrench },
  { key: 'pitch', label: 'Pitch event', group: 'Format', Icon: Presentation },
  { key: 'demo', label: 'Demo day', group: 'Format', Icon: MonitorPlay },
  { key: 'hackathon', label: 'Hackathon', group: 'Format', Icon: Code },
  { key: 'startup', label: 'Startups', group: 'Format', Icon: Rocket },
  { key: 'ideas', label: 'Idea session', group: 'Format', Icon: Lightbulb },

  { key: 'mentors', label: 'Mentors on hand', group: 'Who it helps', Icon: UserCheck },
  { key: 'recruiting', label: 'Recruiting', group: 'Who it helps', Icon: Briefcase },
  { key: 'resume', label: 'Bring your resume', group: 'Who it helps', Icon: FileText },
  { key: 'investors', label: 'Investors attending', group: 'Who it helps', Icon: TrendingUp },
  { key: 'students', label: 'Students', group: 'Who it helps', Icon: GraduationCap },
  { key: 'alumni', label: 'Alumni', group: 'Who it helps', Icon: School },
  { key: 'class-credit', label: 'Class credit', group: 'Who it helps', Icon: BookOpen },

  { key: 'virtual', label: 'Virtual', group: 'Getting there', Icon: Video },
  { key: 'hybrid', label: 'Hybrid', group: 'Getting there', Icon: MonitorSmartphone },
  { key: 'in-person', label: 'In person', group: 'Getting there', Icon: MapPin },
  { key: 'outdoors', label: 'Outdoors', group: 'Getting there', Icon: Trees },
  { key: 'parking', label: 'Parking available', group: 'Getting there', Icon: CircleParking },
  { key: 'shuttle', label: 'Shuttle or bus', group: 'Getting there', Icon: Bus },
  { key: 'accessible', label: 'Wheelchair accessible', group: 'Getting there', Icon: Accessibility },
  { key: 'family', label: 'Family friendly', group: 'Getting there', Icon: Baby },
  { key: 'pets', label: 'Pets welcome', group: 'Getting there', Icon: Dog },

  { key: 'music', label: 'Live music', group: 'At the event', Icon: Music },
  { key: 'social', label: 'Social', group: 'At the event', Icon: PartyPopper },
  { key: 'games', label: 'Games', group: 'At the event', Icon: Gamepad2 },
  { key: 'photos', label: 'Photography', group: 'At the event', Icon: Camera },
  { key: 'recording', label: 'Being recorded', group: 'At the event', Icon: Clapperboard },
  { key: 'wifi', label: 'Wi-Fi', group: 'At the event', Icon: Wifi },
  { key: 'laptop', label: 'Bring a laptop', group: 'At the event', Icon: Laptop },
  { key: 'limited-seats', label: 'Limited seats', group: 'At the event', Icon: Armchair },
  { key: 'rsvp-required', label: 'RSVP required', group: 'At the event', Icon: ClipboardCheck },
  { key: 'drop-in', label: 'Drop in any time', group: 'At the event', Icon: Clock },
  { key: 'attire', label: 'Business attire', group: 'At the event', Icon: Crown },

  { key: 'technology', label: 'Technology', group: 'Topic', Icon: Cpu },
  { key: 'ai', label: 'AI', group: 'Topic', Icon: Bot },
  { key: 'marketing', label: 'Marketing', group: 'Topic', Icon: Megaphone },
  { key: 'finance', label: 'Finance', group: 'Topic', Icon: Calculator },
  { key: 'legal', label: 'Legal', group: 'Topic', Icon: Scale },
  { key: 'health', label: 'Health', group: 'Topic', Icon: HeartPulse },
  { key: 'sustainability', label: 'Sustainability', group: 'Topic', Icon: Leaf },
  { key: 'global', label: 'Global', group: 'Topic', Icon: Globe },
  { key: 'nonprofit', label: 'Nonprofit', group: 'Topic', Icon: HeartHandshake },
];

export const EVENT_ICON_MAP = new Map(EVENT_ICONS.map((icon) => [icon.key, icon]));
