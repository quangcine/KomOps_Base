import { IntercomMonitorScreen } from "@/components/intercom/IntercomMonitorScreen";

// KHÔNG khai `revalidate` ở bất kỳ trang nào của app này: màn sau đăng nhập, dữ liệu theo quyền.
export const dynamic = "force-dynamic";

// Ô Monitor của footer trỏ về đây.
export default function Page() {
  return <IntercomMonitorScreen />;
}
