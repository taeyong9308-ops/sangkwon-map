// 공개용 키만 넣으세요. (Supabase service_role / secret 키는 절대 넣지 마세요)
window.APP_CONFIG = {
  KAKAO_JS_KEY: "a3f4526581dc4ae0d470bab949f65d1d",  // 카카오 디벨로퍼스 → 앱 → 플랫폼 키 → JavaScript 키 (도메인 등록 필요)
  SUPABASE_URL: "https://wusptychagyizhwmyxsy.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_pAVt3U57CnJOyEO7_hguQg_Dej-myK9",  // 공개용 키 (RLS로 보호)
  CENTER: { lat: 37.5603, lng: 126.8325 },  // 처음 화면: 마곡역~발산역 사이
  LEVEL: 4
};
