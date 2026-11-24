import { IntercomBoardScreen } from "@/components/intercom/IntercomBoardScreen";

// KHÔNG khai `revalidate` ở bất kỳ trang nào của app này: màn sau đăng nhập, dữ liệu theo quyền.
export const dynamic = "force-dynamic";

// Dashboard giao nhận intercom cho nhân viên.
export default function Page() {
  return <IntercomBoardScreen />;
}
