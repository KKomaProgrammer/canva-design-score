# Canva Design Score

Canva 프레젠테이션의 각 슬라이드를 브라우저에서 PNG로 캡처하고, Cloudflare Pages Function을 통해 OpenAI 비전 모델로 디자인 완성도를 평가하는 프로젝트입니다.

## 구성

- `extension/`: Chrome/Edge Manifest V3 확장 프로그램
- `functions/api/analyze.js`: OpenAI Responses API 프록시
- `functions/api/health.js`: 배포/환경변수 상태 확인
- `public/`: Cloudflare Pages 안내 화면

## Cloudflare Pages 배포

1. 이 저장소를 Cloudflare Pages에 연결합니다.
2. Framework preset은 `None`, Build command는 비워 두고, Build output directory는 `public`로 설정합니다.
3. Pages 프로젝트의 Settings → Variables and Secrets에서 다음 값을 등록합니다.
   - `OPENAI_API_KEY` (필수, Secret)
   - `API_ACCESS_TOKEN` (권장, Secret): 임의의 긴 문자열
   - `ALLOWED_ORIGINS` (선택): 쉼표로 구분한 허용 Origin. 확장 프로그램은 Origin이 없을 수 있어 Access Token 검증을 권장합니다.
4. 배포 후 `https://<프로젝트>.pages.dev/api/health`가 정상인지 확인합니다.

## 확장 프로그램 설치

1. `extension` 폴더를 ZIP으로 만들고 압축을 풉니다.
2. Chrome/Edge의 확장 프로그램 관리 화면에서 개발자 모드를 켭니다.
3. `압축해제된 확장 프로그램을 로드`로 `extension` 폴더를 선택합니다.
4. Canva 편집 페이지에서 확장 아이콘을 누르고 API 주소와 Access Token을 저장한 뒤 분석을 시작합니다.

기본 모델은 비용 효율적인 `gpt-5.6-luna`이며, 더 엄격한 평가가 필요할 때 `gpt-5.6-terra`를 선택할 수 있습니다. 확장 프로그램은 모든 `.JFv1rQ` 요소를 DOM 순서대로 찾고, 각 요소 안의 첫 번째 `img`를 PNG로 변환합니다. 토큰 절약을 위해 PNG 폭은 전체 페이지 수에 따라 320~768px 범위에서 자동 조정됩니다.

이미지의 직접 Canvas 변환이 브라우저 보안 정책으로 차단되면 확장 프로그램 백그라운드에서 해당 `img` 원본을 가져와 변환합니다. 이 방식도 불가능할 때만 `captureVisibleTab`을 사용하므로 Kiwi Browser의 `No active web contents to capture` 발생 가능성을 줄였습니다.

Kiwi Browser에서는 활성 탭 URL이 비어 있거나 모바일용 주소로 제공될 수 있으므로 URL 문자열만으로 편집 페이지를 판별하지 않습니다. Canva 전체 서브도메인에서 콘텐츠 스크립트를 허용하고 실제 `.JFv1rQ` 페이지 요소의 존재 여부로 편집 화면을 확인합니다.

현재 활성 탭이 `chrome://`, `devtools://`, `edge://`, `about:` 같은 브라우저 내부 페이지이면 DOM 주입이나 화면 캡처를 시도하지 않고 분석을 건너뜁니다. Canva 디자인 편집 탭으로 이동한 뒤 다시 실행해야 합니다.

분석이 끝나면 결과 전용 상호작용 SVG를 다운로드할 수 있습니다. 우측 상단 기록 버튼에서는 저장된 상세 분석을 다시 열거나 삭제할 수 있습니다. 삭제한 기록은 UI에서 영구 삭제하지 않고 `chrome.storage.local`의 `analysisTrash`로 이동합니다. 기록 패널 우측 하단의 휴지통에서 개별 또는 전체 복구할 수 있으며, 휴지통 저장 한도를 넘긴 가장 오래된 기록부터 자동 정리됩니다.

## 보안

- OpenAI API 키는 확장 프로그램에 저장하지 않습니다.
- 공개 Pages 주소를 그대로 두면 제3자가 비용을 발생시킬 수 있으므로 `API_ACCESS_TOKEN`을 설정하십시오.
- 분석 API는 PNG data URL만 받고, 페이지 수와 요청 크기를 제한합니다.
