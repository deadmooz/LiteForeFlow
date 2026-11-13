import {
  Brain, Bot, MessageSquare, Send, Gamepad2, NotebookText, Table2, CreditCard, Magnet, Database, Mail, Play, Webhook, Clock, Rss, Siren, Globe,
  GitBranch, ListOrdered, Merge, Hourglass, Minus, OctagonX, Puzzle, Pencil, Code, Scissors, Package, Hash, Filter, ArrowUpDown, Copy, Boxes,
  CalendarClock, Lock, Reply, Plug, Newspaper, CloudSun, Kanban, CircleCheck, GitPullRequest,
} from 'lucide-react';

// Node icons are saved by name (server/src/nodes, plugins). An unknown name, or an old emoji from a plugin, shows the plain puzzle piece.
const NODE_ICONS = {
  Brain, Bot, MessageSquare, Send, Gamepad2, NotebookText, Table2, CreditCard, Magnet, Database, Mail, Play, Webhook, Clock, Rss, Siren, Globe,
  GitBranch, ListOrdered, Merge, Hourglass, Minus, OctagonX, Puzzle, Pencil, Code, Scissors, Package, Hash, Filter, ArrowUpDown, Copy, Boxes,
  CalendarClock, Lock, Reply, Plug, Newspaper, CloudSun, Kanban, CircleCheck, GitPullRequest,
};
export const NodeIcon = ({ name, size = 16 }) => {
  const Icon = NODE_ICONS[name] ?? Puzzle;
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" />;
};
