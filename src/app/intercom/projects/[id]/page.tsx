import { IntercomProjectDetailScreen } from "@/components/intercom/IntercomProjectDetailScreen";

// KHÔNG khai `revalidate` ở bất kỳ trang nào của app này: màn sau đăng nhập, dữ liệu theo quyền.
export const dynamic = "force-dynamic";

// Chi tiết một dự án intercom. Next 15: `params` là một lời hứa, phải chờ.
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <IntercomProjectDetailScreen projectId={id} />;
}
