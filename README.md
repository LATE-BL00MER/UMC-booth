# UMC Photo Booth

## 실행 방법

Node.js 22 이상이 필요합니다.

프로젝트 폴더에서 아래 명령어를 순서대로 실행하세요.

```bash
npm install
npm run booth
```

## Vercel 운영자 PIN 설정

운영 화면의 PIN은 코드에 저장하지 않고 Vercel 환경 변수로 관리합니다.

1. Vercel에서 `umc-photo-booth` 프로젝트를 엽니다.
2. **Settings → Environment Variables**로 이동합니다.
3. 이름에 `OPERATOR_PIN`, 값에 원하는 **4자리 숫자**를 입력합니다.
4. **Production**과 **Preview**를 선택해 저장합니다.
5. 환경 변수 변경 사항이 적용되도록 Production을 다시 배포합니다.

PIN을 바꿀 때도 같은 곳에서 `OPERATOR_PIN` 값을 수정한 뒤 다시 배포하면 됩니다.
