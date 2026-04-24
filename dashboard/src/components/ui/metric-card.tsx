import { LucideIcon, TrendingUp, TrendingDown, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card";

interface MetricCardProps {
  label: string;
  value: string | number;
  subtitle?: string;
  icon: LucideIcon;
  iconColor?: "blue" | "purple" | "green" | "orange" | "red" | "gray";
  trend?: "up" | "down" | "neutral";
  trendValue?: string | number;
  loading?: boolean;
}

const iconColorClasses = {
  blue: "text-blue-600 dark:text-blue-400",
  purple: "text-purple-600 dark:text-purple-400",
  green: "text-green-600 dark:text-green-400",
  orange: "text-orange-600 dark:text-orange-400",
  red: "text-red-600 dark:text-red-400",
  gray: "text-gray-600 dark:text-gray-400",
};

export function MetricCard({ 
  label, 
  value, 
  subtitle, 
  icon: Icon, 
  iconColor = "blue",
  trend,
  trendValue,
  loading = false
}: MetricCardProps) {
  const getTrendIcon = () => {
    if (trend === "up") return TrendingUp;
    if (trend === "down") return TrendingDown;
    return null;
  };

  const getTrendColor = () => {
    if (trend === "up") return "text-green-600 dark:text-green-400";
    if (trend === "down") return "text-red-600 dark:text-red-400";
    return "text-muted-foreground";
  };

  const TrendIcon = getTrendIcon();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardDescription>{label}</CardDescription>
          <div className={`h-10 w-10 ${iconColorClasses[iconColor]}`}>
            <Icon className="h-full w-full" />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-2">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <CardTitle className="font-bold mb-1 text-card-foreground" style={{ fontSize: 'var(--metric-card-value-size)' }}>{value}</CardTitle>
              {trend && TrendIcon && (
                <div className={`flex items-center gap-1 ${getTrendColor()}`}>
                  <TrendIcon className="h-4 w-4" />
                  {trendValue && (
                    <span className="text-sm font-medium">{trendValue}</span>
                  )}
                </div>
              )}
            </div>
            {subtitle && (
              <p className="text-xs text-muted-foreground">{subtitle}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
