import { requirePractice } from "@/lib/auth/rbac";
import { listPatients } from "@/lib/phi";

export default async function PatientsPage() {
  const ctx = await requirePractice("phi.view");
  const patients = await listPatients(ctx, { take: 100 });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Patients</h1>
        <a className="btn-secondary" href="/api/export/patients">Export CSV</a>
      </div>
      <p className="text-sm text-stone-500">Viewing and exporting patient information is recorded in the audit log.</p>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-stone-500"><th className="p-3">Name</th><th>Date of birth</th><th>Member ID</th></tr></thead>
          <tbody>
            {patients.map((p) => (
              <tr key={p.id} className="border-t"><td className="p-3">{p.lastName}, {p.firstName}</td><td>{p.dob}</td><td>{p.memberId}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
