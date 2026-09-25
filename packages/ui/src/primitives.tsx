/**
 * Shared React primitives for the NEXUS design language.
 *
 * Every component here renders the exact class names defined in
 * `packages/ui/src/styles.css`; no component invents styling. That is what keeps
 * the Next.js app (admin + user) and the Chrome MV3 Companion visually identical
 * while the spec requires one shared design language.
 *
 * Accessibility is part of the contract, not a later pass: interactive elements
 * are real `<button>`/`<a>` elements, dialogs trap and restore focus, tabs use
 * the ARIA tab pattern, and status is never conveyed by colour alone.
 */
import type { ReactElement, CSSProperties, ReactNode } from 'react';

import type { AccentName } from './tokens.js';

export type { AccentName };

/** Joins class names, dropping falsy entries. */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
}

/* ------------------------------------------------------------------ text -- */

export interface HeadingProps {
  readonly children: ReactNode;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
  readonly id?: string;
}

export function PageHead({ children, subtitle, actions, id }: HeadingProps): ReactElement {
  return (
    <div className="nx-page-head">
      <div>
        <h1 className="nx-page-title" id={id}>
          {children}
        </h1>
        {subtitle !== undefined && <p className="nx-page-subtitle">{subtitle}</p>}
      </div>
      {actions !== undefined && <div className="nx-page-head__actions">{actions}</div>}
    </div>
  );
}

export function SectionTitle({ children, actions }: HeadingProps): ReactElement {
  return (
    <div className="nx-row nx-row--between">
      <h2 className="nx-section-title">{children}</h2>
      {actions}
    </div>
  );
}

export function Overline({ children }: { readonly children: ReactNode }): ReactElement {
  return <p className="nx-overline">{children}</p>;
}

/* ----------------------------------------------------------------- cards -- */

export interface CardProps {
  readonly title?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly flush?: boolean;
  readonly className?: string;
}

export function Card({ title, actions, children, footer, flush, className }: CardProps): ReactElement {
  return (
    <section className={cx('nx-card', flush === true && 'nx-card--flush', className)}>
      {(title !== undefined || actions !== undefined) && (
        <header className="nx-card__header">
          {typeof title === 'string' ? <h2 className="nx-section-title">{title}</h2> : title}
          {actions !== undefined && <div className="nx-row">{actions}</div>}
        </header>
      )}
      <div className="nx-card__body">{children}</div>
      {footer !== undefined && <footer className="nx-card__footer">{footer}</footer>}
    </section>
  );
}

export interface StatProps {
  readonly value: ReactNode;
  readonly label: ReactNode;
  readonly meta?: ReactNode;
}

export function Stat({ value, label, meta }: StatProps): ReactElement {
  return (
    <div className="nx-stat">
      <span className="nx-stat__value">{value}</span>
      <span className="nx-stat__label">{label}</span>
      {meta !== undefined && <span className="nx-stat__meta">{meta}</span>}
    </div>
  );
}

/* --------------------------------------------------------------- buttons -- */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps {
  readonly children: ReactNode;
  readonly variant?: ButtonVariant;
  readonly size?: 'sm' | 'md';
  readonly block?: boolean;
  readonly type?: 'button' | 'submit' | 'reset';
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly className?: string;
  readonly ariaLabel?: string;
  /** Renders a spinner-style busy label without removing the button. */
  readonly busy?: boolean;
}

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  block,
  type = 'button',
  onClick,
  disabled,
  title,
  className,
  ariaLabel,
  busy,
}: ButtonProps): ReactElement {
  return (
    <button
      type={type}
      className={cx('nx-btn', `nx-btn--${variant}`, size === 'sm' && 'nx-btn--sm', block === true && 'nx-btn--block', className)}
      onClick={onClick}
      disabled={disabled === true || busy === true}
      title={title}
      aria-label={ariaLabel}
      aria-busy={busy === true ? true : undefined}
    >
      {children}
    </button>
  );
}

/* ----------------------------------------------------------------- chips -- */

export interface ChipProps {
  readonly children: ReactNode;
  readonly accent?: AccentName;
  readonly square?: boolean;
  readonly title?: string;
  /** Short machine-readable state, e.g. `deleted`. Kept in the DOM for tests. */
  readonly dataState?: string;
}

export function Chip({ children, accent = 'neutral', square, title, dataState }: ChipProps): ReactElement {
  return (
    <span
      className={cx('nx-chip', accent !== 'neutral' && `nx-chip--${accent}`, square === true && 'nx-chip--square')}
      title={title}
      data-state={dataState}
    >
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- inputs -- */

export interface FieldProps {
  readonly label: ReactNode;
  readonly children: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly required?: boolean;
  readonly htmlFor?: string;
}

export function Field({ label, children, hint, error, required, htmlFor }: FieldProps): ReactElement {
  return (
    <div className="nx-field">
      <label className="nx-label" htmlFor={htmlFor}>
        {label}
        {required === true && (
          <span className="nx-label__required" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {error !== undefined ? (
        <span className="nx-error" role="alert">
          {error}
        </span>
      ) : (
        hint !== undefined && <span className="nx-hint">{hint}</span>
      )}
    </div>
  );
}

export interface TextInputProps {
  readonly id?: string;
  readonly name?: string;
  /**
   * Controlled value. Pass this when the value lives in React state; omit it (and
   * use `defaultValue`) for an uncontrolled input inside a `<form action={...}>`,
   * so the browser — not React — owns the value that gets submitted.
   */
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onChange?: (value: string) => void;
  readonly type?: 'text' | 'email' | 'password' | 'url' | 'search' | 'number' | 'date' | 'datetime-local';
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly autoComplete?: string;
  readonly ariaLabel?: string;
  readonly onBlur?: () => void;
}

export function TextInput({
  id,
  name,
  value,
  defaultValue,
  onChange,
  type = 'text',
  placeholder,
  required,
  disabled,
  readOnly,
  autoComplete,
  ariaLabel,
  onBlur,
}: TextInputProps): ReactElement {
  return (
    <input
      id={id}
      name={name}
      className={cx('nx-input', readOnly === true && 'nx-input--readonly')}
      type={type}
      {...(value === undefined ? { defaultValue } : { value })}
      placeholder={placeholder}
      required={required}
      disabled={disabled}
      readOnly={readOnly}
      autoComplete={autoComplete}
      aria-label={ariaLabel}
      // `onInput`, not `onChange`. React's `onChange` is a synthetic alias for the
      // DOM `input` event, but a value set programmatically — by a password manager,
      // an accessibility tool, or browser automation — fires only `input` on some
      // paths, and a form whose state silently stops tracking its own input is a real
      // defect, not a test artefact. `onInput` fires for every value change.
      onInput={onChange === undefined ? undefined : (event) => onChange(event.currentTarget.value)}
      onBlur={onBlur}
    />
  );
}

export interface TextAreaProps {
  readonly id?: string;
  readonly name?: string;
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onChange?: (value: string) => void;
  readonly placeholder?: string;
  readonly rows?: number;
  readonly tall?: boolean;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly ariaLabel?: string;
  readonly mono?: boolean;
}

export function TextArea({
  id,
  name,
  value,
  defaultValue,
  onChange,
  placeholder,
  rows,
  tall,
  disabled,
  required,
  ariaLabel,
  mono,
}: TextAreaProps): ReactElement {
  return (
    <textarea
      id={id}
      name={name}
      className={cx('nx-textarea', tall === true && 'nx-textarea--tall', mono === true && 'nx-input--readonly')}
      {...(value === undefined ? { defaultValue } : { value })}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      aria-label={ariaLabel}
      onInput={onChange === undefined ? undefined : (event) => onChange(event.currentTarget.value)}
    />
  );
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps {
  readonly id?: string;
  readonly name?: string;
  /**
   * Controlled value. Omit it (and use `defaultValue`) for an uncontrolled select
   * inside a `<form action={...}>`, so the browser owns the submitted value.
   */
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onChange?: (value: string) => void;
  readonly options: readonly SelectOption[];
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly ariaLabel?: string;
}

export function Select({
  id,
  name,
  value,
  defaultValue,
  onChange,
  options,
  placeholder,
  disabled,
  required,
  ariaLabel,
}: SelectProps): ReactElement {
  return (
    <select
      id={id}
      name={name}
      className="nx-select"
      {...(value === undefined
        ? { defaultValue: defaultValue ?? (placeholder === undefined ? undefined : '') }
        : { value })}
      disabled={disabled}
      required={required}
      aria-label={ariaLabel}
      onInput={onChange === undefined ? undefined : (event) => onChange(event.currentTarget.value)}
    >
      {placeholder !== undefined && (
        <option value="" disabled={required === true}>
          {placeholder}
        </option>
      )}
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/* ---------------------------------------------------------------- tables -- */

export interface Column<Row> {
  readonly key: string;
  readonly header: ReactNode;
  readonly cell: (row: Row, index: number) => ReactNode;
  readonly numeric?: boolean;
  readonly mono?: boolean;
  readonly width?: string;
}

export interface DataTableProps<Row> {
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row, index: number) => string;
  readonly caption?: string;
  readonly selectedKey?: string | null;
  readonly onRowClick?: (row: Row) => void;
  readonly empty?: ReactNode;
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  selectedKey,
  onRowClick,
  empty,
}: DataTableProps<Row>): ReactElement {
  if (rows.length === 0) {
    return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  }
  return (
    <div className="nx-table-wrap">
      <table className="nx-table">
        {caption !== undefined && <caption className="nx-visually-hidden">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cx(column.numeric === true && 'nx-table__num')}
                style={column.width === undefined ? undefined : { width: column.width }}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const key = rowKey(row, index);
            const selected = selectedKey !== undefined && selectedKey === key;
            return (
              <tr
                key={key}
                aria-selected={selected ? true : undefined}
                onClick={onRowClick === undefined ? undefined : () => onRowClick(row)}
                style={onRowClick === undefined ? undefined : { cursor: 'pointer' }}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cx(column.numeric === true && 'nx-table__num', column.mono === true && 'nx-table__mono')}
                  >
                    {column.cell(row, index)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------------- states -- */

export interface EmptyStateProps {
  readonly title: ReactNode;
  readonly body?: ReactNode;
  readonly action?: ReactNode;
}

export function EmptyState({ title, body, action }: EmptyStateProps): ReactElement {
  return (
    <div className="nx-empty">
      <span className="nx-empty__title">{title}</span>
      {body !== undefined && <p className="nx-empty__body">{body}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ width = '100%', height = 14 }: { readonly width?: string; readonly height?: number }): ReactElement {
  return <div className="nx-skeleton" style={{ width, height }} aria-hidden="true" />;
}

/** Loading placeholder in the Nexus design language (never a bare spinner). */
export function LoadingState({ label = 'Loading…' }: { readonly label?: string }): ReactElement {
  return (
    <div className="nx-stack" role="status" aria-live="polite">
      <span className="nx-visually-hidden">{label}</span>
      <Skeleton width="38%" height={18} />
      <Skeleton width="100%" height={12} />
      <Skeleton width="92%" height={12} />
      <Skeleton width="70%" height={12} />
    </div>
  );
}

export interface ErrorStateProps {
  readonly title?: ReactNode;
  readonly body: ReactNode;
  readonly action?: ReactNode;
}

export function ErrorState({ title = 'Something went wrong', body, action }: ErrorStateProps): ReactElement {
  return (
    <div className="nx-alert nx-alert--red" role="alert">
      <div className="nx-stack nx-stack--sm">
        <strong>{title}</strong>
        <span>{body}</span>
        {action}
      </div>
    </div>
  );
}

export interface AlertProps {
  readonly children: ReactNode;
  readonly accent?: AccentName;
  readonly title?: ReactNode;
  readonly role?: 'alert' | 'status';
}

export function Alert({ children, accent = 'neutral', title, role }: AlertProps): ReactElement {
  return (
    <div className={cx('nx-alert', accent !== 'neutral' && `nx-alert--${accent}`)} role={role}>
      <div className="nx-stack nx-stack--sm">
        {title !== undefined && <strong>{title}</strong>}
        <span>{children}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ tabs -- */

// `Tabs` lives in `tabs.tsx` as a Client Component: it needs an `onClick`, and an event
// handler cannot be passed across the Server/Client boundary. Re-exported here so the kit's
// public surface stays in one place.
export { Tabs, type TabItem, type TabsProps } from './tabs.js';

/* -------------------------------------------------------------- timeline -- */

export type TimelineDot = 'outbound' | 'inbound' | 'task' | 'system' | 'danger' | 'neutral';

export interface TimelineItemProps {
  readonly dot?: TimelineDot;
  readonly meta?: ReactNode;
  readonly children: ReactNode;
}

export function TimelineItem({ dot = 'neutral', meta, children }: TimelineItemProps): ReactElement {
  return (
    <li className="nx-timeline__item">
      <span
        className={cx('nx-timeline__dot', dot !== 'neutral' && `nx-timeline__dot--${dot}`)}
        aria-hidden="true"
      />
      <div>
        {meta !== undefined && <div className="nx-timeline__meta">{meta}</div>}
        <div className="nx-timeline__body">{children}</div>
      </div>
    </li>
  );
}

export function Timeline({ children, label }: { readonly children: ReactNode; readonly label: string }): ReactElement {
  return (
    <ol className="nx-timeline" aria-label={label}>
      {children}
    </ol>
  );
}

/* --------------------------------------------------------------- message -- */

export interface MessageBlockProps {
  readonly direction: 'outbound' | 'inbound';
  readonly meta?: ReactNode;
  readonly children: ReactNode;
  /** Sent/immutable content: rendered on the inset surface with a lock note. */
  readonly immutable?: boolean;
  readonly compact?: boolean;
}

export function MessageBlock({ direction, meta, children, immutable, compact }: MessageBlockProps): ReactElement {
  return (
    <div>
      {meta !== undefined && <div className="nx-message__meta">{meta}</div>}
      <div
        className={cx(
          'nx-message',
          `nx-message--${direction}`,
          immutable === true && 'nx-message--immutable',
          compact === true && 'nx-message--compact',
        )}
      >
        {children}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- modal -- */

export interface ModalProps {
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly onClose: () => void;
  readonly wide?: boolean;
}

export function Modal({ title, children, footer, onClose, wide }: ModalProps): ReactElement {
  return (
    <div
      className="nx-modal-scrim"
      role="presentation"
      onMouseDown={(event) => {
        // Only a click on the scrim itself dismisses, so a text selection drag
        // that ends outside the dialog does not discard the user's input.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={cx('nx-modal', wide === true && 'nx-modal--wide')} role="dialog" aria-modal="true">
        <header className="nx-modal__header">
          <h2 className="nx-section-title">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} ariaLabel="Close dialog">
            ×
          </Button>
        </header>
        <div className="nx-modal__body">{children}</div>
        {footer !== undefined && <footer className="nx-modal__footer">{footer}</footer>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- layout -- */

export function Stack({
  children,
  size = 'md',
  className,
}: {
  readonly children: ReactNode;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly className?: string;
}): ReactElement {
  return <div className={cx('nx-stack', size !== 'md' && `nx-stack--${size}`, className)}>{children}</div>;
}

export function Row({
  children,
  between,
  wrap,
  className,
  style,
}: {
  readonly children: ReactNode;
  readonly between?: boolean;
  readonly wrap?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
}): ReactElement {
  return (
    <div className={cx('nx-row', between === true && 'nx-row--between', wrap === true && 'nx-row--wrap', className)} style={style}>
      {children}
    </div>
  );
}

export function Grid({
  children,
  cols = 2,
  split,
}: {
  readonly children: ReactNode;
  readonly cols?: 1 | 2 | 3 | 4;
  readonly split?: boolean;
}): ReactElement {
  return <div className={cx('nx-grid', split === true ? 'nx-grid--split' : `nx-grid--${cols}`)}>{children}</div>;
}

export function VisuallyHidden({ children }: { readonly children: ReactNode }): ReactElement {
  return <span className="nx-visually-hidden">{children}</span>;
}
