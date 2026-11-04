import re
NEGATIVE=re.compile(r'没有|不存在|未收到|未完成|未返回|未成功|未发生|未发现|未找到|没找到|没发现|找不到|未出现|未见|没看到|看不到|未匹配|缺少|缺失|\b(?:missing|lacks?|lacking)\b|no\b[^。；;\n]{0,80}\b(?:records?|logs?|entries|entry|markers?)\b|never|not found|not received|didn.t|no\b[^。；;\n]{0,80}\bfound|none found|\babsent\b',re.I)


def negative_fact(text):
    # Check claims field by field; uncertainty itself is not an absence claim.
    return bool(NEGATIVE.search(re.sub(r'无法确认[^。；;]*','',text)))


