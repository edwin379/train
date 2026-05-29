import urllib.request
import json

url = 'https://api.odpt.org/api/v4/odpt:Station?odpt:operator=odpt.Operator:TokyoMetro&acl:consumerKey=2swbs2ofcui4yan1ri19phbxes2r5gxdxhhxbomczfuayo6jobyrl1atiyyy68ym'
with urllib.request.urlopen(url) as r:
    data = json.load(r)
print(json.dumps(data[0], indent=2, ensure_ascii=False)[:2000])
print('\nTotal records:', len(data))
