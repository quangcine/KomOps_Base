import { IntercomMeScreen } from "@/components/intercom/IntercomMeScreen";

// KHÔNG khai `revalidate` ở bất kỳ trang nào của app này: màn sau đăng nhập, dữ liệu theo quyền.
export const dynamic = "force-dynamic";

export default function Page() {
  return <IntercomMeScreen />;
}
