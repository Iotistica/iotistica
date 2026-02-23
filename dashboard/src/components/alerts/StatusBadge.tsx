import { Badge } from "@/components/ui/badge";
import { Circle } from "lucide-react";

interface StatusBadgeProps {
  status: 'open' | 'active' | 'resolved';
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = {
    open: {
      className: 'bg-gray-500 text-white',
      label: 'OPEN',
    },
    active: {
      className: 'bg-orange-500 text-white',
      label: 'ACTIVE',
    },
    resolved: {
      className: 'bg-green-500 text-white',
      label: 'RESOLVED',
    },
  };

  const { className, label } = config[status];

  return (
    <Badge className={`${className} flex items-center gap-1 w-fit`}>
      <Circle className="w-2 h-2 fill-current" />
      {label}
    </Badge>
  );
}
