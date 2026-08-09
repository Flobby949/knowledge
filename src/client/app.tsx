import { Navigate, Route, Routes } from "react-router-dom";

import { HomePage } from "./home-page.js";
import { RecordDetailPage } from "./record-detail-page.js";
import { RecordsPage } from "./records-page.js";
import { ReviewPage } from "./review-page.js";
import { SearchPage } from "./search-page.js";
import { SettingsPage } from "./settings-page.js";
import { TagsPage } from "./tags-page.js";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/records" element={<RecordsPage />} />
      <Route path="/records/:recordId" element={<RecordDetailPage />} />
      <Route path="/review" element={<ReviewPage />} />
      <Route path="/search" element={<SearchPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/tags" element={<TagsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
