# 상권 기입 지도 (카카오맵 PWA)

임장하면서 상권 라인별 유동인구(많음/보통/적음), 관찰 메모, 특징 태그, 사진, 메모 핀을 카카오맵 위에 바로 기입하는 웹앱입니다. 폰 홈 화면에 추가하면 앱처럼 쓸 수 있어요.

## 기능
- 시간대 4개(평일 점심·저녁, 주말 점심·저녁)별 라인 판정과 관찰 메모
- 라인 그리기(점 여러 개) / 지점(점 1개: 사거리·몰), 선 모양 다시 그리기
- 카카오 장소 검색 → 그 위치로 이동하거나 핀으로 저장
- 메모 핀 (관찰·특징·매물), 사진 첨부 (폰 카메라)
- 음성 입력 (크롬·안드로이드. 안 되면 키보드 마이크 사용)
- 비교표, CSV·JSON 내보내기, 구역 경계(W·C·E1·E2) 표시
- 폰·PC 실시간 동기화 (Supabase)

## 설정
1. **Supabase**: SQL Editor에서 `supabase/schema.sql` 실행 → `supabase/seed.sql` 실행(기존 23개 라인·매물 6개).
   Authentication → URL Configuration의 Site URL을 배포 주소로 설정. 본인 계정으로 처음 로그인한 뒤 Authentication → Sign In / Providers에서 새 가입(Allow new users to sign up)을 끄면 다른 사람은 가입할 수 없어요.
2. **카카오**: developers.kakao.com → 앱의 플랫폼(Web)에 배포 도메인과 `http://localhost:8000` 등록, 카카오맵 사용 설정.
3. `config.js`에 카카오 JavaScript 키, Supabase URL·anon 키 입력 (모두 공개용 키).
4. **배포**: GitHub 저장소 Settings → Pages → Branch `main` / root.

로컬 확인: 이 폴더에서 `python3 -m http.server 8000` → http://localhost:8000
Supabase 값을 비워 두면 이 기기(localStorage)에만 저장하는 모드로 동작합니다.
