import { Badge } from "@/components/ui/badge";
import { Info, AlertTriangle, AlertOctagon } from "lucide-react";

interface SeverityBadgeProps {
  severity: 'info' | 'warning' | 'critical';
}

export function SeverityBadge({ severity }: SeverityBadgeProps) {
  const config = {
    info: {
      icon: Info,
      className: 'bg-blue-500 text-white',
      label: 'INFO',
    },
    warning: {
      icon: AlertTriangle,
      className: 'bg-yellow-500 text-white',
      label: 'WARNING',
    },
    critical: {
      icon: AlertOctagon,
      className: 'bg-red-500 text-white',
      label: 'CRITICAL',
    },
  };

  const { icon: Icon, className, label } = config[severity];

  return (
    <Badge className={`${className} flex items-center gap-1 w-fit`}>
      <Icon className="w-3 h-3" />
      {label}
    </Badge>
  );
}
