#!/usr/bin/env python3
"""11.5 가격 연동: 클라우드 공식 가격 API에서 한국·일본 리전 가격만 받아 data/prices/*.json 형식으로 저장한다.

사용법:
    python tools/fetch_prices.py azure --sku Standard_D2s_v5 --regions koreacentral japaneast
    python tools/fetch_prices.py aws    # 인증이 필요해 지금은 안내만 출력

Azure Retail Prices API는 인증 없이 읽을 수 있는 공개 API다. 받은 날을 기준일(as_of)로, 요청 URL을 출처로 남긴다.
"""
import argparse
import datetime
import json
import os
import sys
import urllib.parse
import urllib.request

AZURE_API = "https://prices.azure.com/api/retail/prices"
ALLOWED = {"koreacentral", "koreasouth", "japaneast", "japanwest"}  # 가격표는 한국·일본 리전만 받는다


def azure_vm_hourly(sku: str, region: str, product: str) -> dict:
    flt = (f"serviceName eq 'Virtual Machines' and armRegionName eq '{region}' "
           f"and armSkuName eq '{sku}' and priceType eq 'Consumption'")
    url = f"{AZURE_API}?{urllib.parse.urlencode({'$filter': flt})}"
    with urllib.request.urlopen(url, timeout=30) as resp:
        items = json.load(resp)["Items"]
    # 리눅스 정가만: 스팟·저우선순위·윈도우 라이선스 포함 가격은 뺀다
    linux = [i for i in items if "Windows" not in i["productName"] and "Spot" not in i["skuName"] and "Low Priority" not in i["skuName"]]
    if not linux:
        raise SystemExit(f"{region} {sku}: 가격을 찾지 못했습니다")
    item = min(linux, key=lambda i: i["retailPrice"])
    if item["unitOfMeasure"] != "1 Hour":
        raise SystemExit(f"예상과 다른 단위: {item['unitOfMeasure']}")
    return {
        "id": f"azure-{region}-{sku}",
        "product": product,
        "region": f"azure:{region}",
        "unit": "hour",
        "price": item["retailPrice"],
        "currency": item["currencyCode"],
        "as_of": datetime.date.today().isoformat(),
        "source": url,
    }


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")  # Windows 콘솔(cp949)에서 한글이 깨지지 않게
    sys.stderr.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cloud", choices=["azure", "aws", "gcp"])
    ap.add_argument("--sku", default="Standard_D2s_v5")
    ap.add_argument("--product", default="vm-2vcpu", help="카탈로그 billing.products가 가리키는 상품 키")
    ap.add_argument("--regions", nargs="+", default=["koreacentral", "japaneast"])
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "prices"))
    a = ap.parse_args()
    if a.cloud != "azure":
        # AWS Price List API·GCP Cloud Billing Catalog API는 계정 인증이 필요하다. 키는 환경 변수로만 읽도록 만들 예정
        print(f"{a.cloud}: 계정 인증이 필요해 아직 지원하지 않습니다. 공개 가격 페이지를 보고 data/prices에 직접 넣어 주세요.", file=sys.stderr)
        sys.exit(2)
    bad = set(a.regions) - ALLOWED
    if bad:
        raise SystemExit(f"한국·일본 리전만 받습니다: {', '.join(sorted(bad))}")
    rows = [azure_vm_hourly(a.sku, r, a.product) for r in a.regions]
    path = os.path.join(a.out, f"azure-{a.sku}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
    print(f"{len(rows)}개 저장: {os.path.normpath(path)}")


if __name__ == "__main__":
    main()
