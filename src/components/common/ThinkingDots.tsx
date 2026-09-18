interface ThinkingDotsProps {
  className?: string;
}

export function ThinkingDots({ className }: ThinkingDotsProps) {
  return (
    <span className={`thinking-dots ${className || ""}`}>
      <span />
      <span />
      <span />
    </span>
  );
}
