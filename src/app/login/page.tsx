import { AuthForm, AuthShell } from "@/components/AuthForm";
import { loginAction } from "@/lib/actions/auth";

export default function LoginPage() {
  return (
    <AuthShell title="Sign in">
      <AuthForm action={loginAction} submit="Continue" fields={[
        { name: "email", label: "Email", type: "email", autoComplete: "username", autoFocus: true },
        { name: "password", label: "Password", type: "password", autoComplete: "current-password" },
      ]} />
      <p className="mt-4 text-xs text-stone-500">Authorized users only. All access to patient information is logged.</p>
    </AuthShell>
  );
}
