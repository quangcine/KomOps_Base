import { IntercomDriveBenchScreen } from "@/components/intercom/IntercomDriveBenchScreen";

// KHÔNG khai `revalidate` ở bất kỳ trang nào của app này: màn sau đăng nhập, dữ liệu theo quyền.
export const dynamic = "force-dynamic";

// Màn đo Drive: không có link từ menu. Next 15: `searchParams` là một lời hứa, phải chờ.
export default async function Page({ searchParams }: { searchParams: Promise<{ project?: string | string[] }> }) {
  const { project } = await searchParams;
  return <IntercomDriveBenchScreen projectId={typeof project === "string" ? project : null} />;
}
