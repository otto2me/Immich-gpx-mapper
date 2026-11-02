<script lang="ts">
  import { api, type SharedReportData } from "./api.js";
  import ReportEditor from "./ReportEditor.svelte";

  let { token }: { token: string } = $props();
  let data = $state<SharedReportData | null>(null);

  async function loadReport() {
    try {
      data = await api.sharedReport(token);
      return data.report;
    } catch (error) {
      data = null;
      throw error;
    }
  }

  function openTour(id: string) {
    if (!data) return;
    location.assign(`/?${new URLSearchParams({ album: data.albumId, tour: id })}`);
  }
</script>

<ReportEditor
  album={{ id: data?.albumId ?? "", albumName: "Reisebericht" }}
  tours={data?.tours ?? []}
  canEdit={false}
  onOpenTour={openTour}
  {loadReport}
/>