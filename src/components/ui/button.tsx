import { cn } from '@/lib/utils'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
}

export function Button({
  children, className, variant = 'primary', size = 'md', ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 font-medium rounded-lg transition-colors',
        'focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed',
        size === 'sm' && 'px-3 py-1.5 text-sm',
        size === 'md' && 'px-4 py-2 text-sm',
        variant === 'primary' && 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500',
        variant === 'secondary' && 'bg-gray-100 text-gray-700 hover:bg-gray-200 focus:ring-gray-400',
        variant === 'ghost' && 'text-gray-600 hover:bg-gray-100 focus:ring-gray-400',
        variant === 'danger' && 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}
