import React from 'react';
import { LoaderCircle } from 'lucide-react';
import { RULES } from '../sim/rules.mjs';

export function Button({
  variant = 'secondary',
  size,
  icon: Icon,
  iconRight: IconRight,
  hint,
  className = '',
  children,
  ...props
}) {
  return (
    <button
      type="button"
      className={`btn btn-${variant} ${size ? 'btn-' + size : ''} ${className}`}
      {...props}
    >
      {Icon && <Icon size={18} strokeWidth={1.75} aria-hidden="true" />}
      {children && <span className="btn-label">{children}</span>}
      {hint && <Kbd>{hint}</Kbd>}
      {IconRight && <IconRight size={16} strokeWidth={1.75} aria-hidden="true" />}
    </button>
  );
}

export function IconButton({ icon: Icon, label, active, className = '', badge, ...props }) {
  return (
    <button
      type="button"
      className={`icon-btn ${active ? 'is-active' : ''} ${className}`}
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : Boolean(active)}
      {...props}
    >
      <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
      {badge && <span className="icon-badge" />}
    </button>
  );
}

export const Kbd = ({ children }) => <kbd className="kbd">{children}</kbd>;

export function Segmented({ value, options, onChange, label, size, disabled, variant }) {
  return (
    <div
      className={`segmented ${size ? 'segmented-' + size : ''} ${variant ? 'segmented-' + variant : ''}`}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          role="radio"
          aria-checked={value === option.value}
          className={value === option.value ? 'is-selected' : ''}
          disabled={disabled || option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, description, disabled }) {
  return (
    <label className={`toggle-row ${disabled ? 'is-disabled' : ''}`}>
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {description && <span className="toggle-description">{description}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={Boolean(checked)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch" aria-hidden="true" />
    </label>
  );
}

export const Spinner = ({ size = 16 }) => (
  <LoaderCircle className="spin" size={size} strokeWidth={2} aria-hidden="true" />
);

export const Dot = ({ tone = 'muted' }) => <i className={`dot dot-${tone}`} aria-hidden="true" />;

export function Progress({ value, label }) {
  const percent = Math.round(Math.max(0, Math.min(1, value || 0)) * 100);
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <i style={{ width: `${percent}%` }} />
    </div>
  );
}

const HEART = 'M12 21S2 15 2 8a5 5 0 0 1 10-2 5 5 0 0 1 10 2c0 7-10 13-10 13Z';
export function Hearts({ value, max = RULES.humanHearts, known = true, label }) {
  const amount = known ? Math.max(0, value ?? max) : 0;
  return (
    <span
      className={`hearts ${known ? '' : 'is-unknown'}`}
      role="img"
      aria-label={known ? `${label}: ${amount} of ${max} hearts` : `${label}: health unknown`}
      title={known ? undefined : 'You can’t see it right now'}
    >
      {Array.from({ length: Math.ceil(max) }, (_, i) => (
        <span className="heart" key={i}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={HEART} />
          </svg>
          {/* Unknown health is dashed outlines, never the empty hearts of a destroyed guard. */}
          {known && (
            <i style={{ width: `${Math.max(0, Math.min(1, amount - i)) * 100}%` }}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d={HEART} />
              </svg>
            </i>
          )}
        </span>
      ))}
      {!known && (
        <span className="hearts-unknown" aria-hidden="true">
          ?
        </span>
      )}
    </span>
  );
}

export function Field({ label, hint, children, className = '' }) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Popover({ className = '', children, label, ...props }) {
  return (
    <div className={`popover ${className}`} role="dialog" aria-label={label} {...props}>
      {children}
    </div>
  );
}
