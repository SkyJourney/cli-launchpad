import clsx from "clsx";
import type {
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";

interface FormFieldProps {
  id: string;
  label: string;
  children: ReactNode;
}

export function FormField({ id, label, children }: FormFieldProps) {
  return (
    <div className="form-field">
      <label className="form-field-label" htmlFor={id}>
        {label}
      </label>
      {children}
    </div>
  );
}

export function TextInput({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx("form-control", className)} />;
}

export function TextArea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={clsx("form-control form-control-multiline", className)}
    />
  );
}
