import { AuthForm, AuthShell } from "@/components/AuthForm";
import { changePasswordAction } from "@/lib/actions/auth";

export default function ChangePasswordPage() {
  return (
    <AuthShell title="Choose your password">
      <p className="mb-4 text-sm text-stone-600">At least 12 characters, mixing letters, numbers and symbols. A short sentence works well.</p>
      <AuthForm action={changePasswordAction} submit="Save password" fields={[
        { name: "current", label: "Temporary password", type: "password", autoComplete: "current-password" },
        { name: "next", label: "New password", type: "password", autoComplete: "new-password" },
        { name: "confirm", label: "Confirm new password", type: "password", autoComplete: "new-password" },
      ]} />
    </AuthShell>
  );
}
