import { Badge } from "@/components/ui/badge";

interface ScoreBadgeProps {
  score: number;
}

export function ScoreBadge({ score }: ScoreBadgeProps) {
  let className = 'bg-blue-500 text-white';

  if (score >= 0.85) {
    className = 'bg-red-500 text-white';
  } else if (score >= 0.7) {
    className = 'bg-yellow-500 text-white';
  }

  return (
    <Badge className={`${className} w-fit`}>
      {score.toFixed(3)}
    </Badge>
  );
}
