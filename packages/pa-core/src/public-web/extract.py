"""Fixed inert HTMLParser worker. stdin=bounded UTF-8, stdout=one JSON object.
No URL, filesystem destination, user code, imports from the working directory or network.
"""
import json
import re
import sys
import resource
from html.parser import HTMLParser
from html import unescape

LIMIT = 2 * 1024 * 1024
VOID = set('area base br col embed hr img input link meta param source track wbr'.split())
IGNORED = set('script style template iframe object embed svg math form noscript noembed textarea xmp head'.split())
RAW = ('script', 'style', 'iframe', 'noscript', 'noembed', 'textarea', 'title', 'xmp')
BLOCK = set('p div br hr li tr section article header footer h1 h2 h3 h4 h5 h6 pre blockquote ul ol table'.split())


def inert(value):
    value = re.sub(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)', '', value)
    value = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', value)
    value = re.sub(r'[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]', '', value)
    value = value.replace('\r\n', '\n').replace('\r', '\n')
    # Preserve code indentation/tabs; normalize only blank-line runs and trailing spaces.
    value = re.sub(r'[ \t]+\n', '\n', value)
    return re.sub(r'\n(?:[ \t]*\n){2,}', '\n\n', value).strip()


class Extract(HTMLParser):
    CDATA_CONTENT_ELEMENTS = RAW

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.parts = []
        self.article_parts = []
        self.title_parts = []
        self.articles = 0

    def muted(self):
        return any(item[1] for item in self.stack)

    def in_article(self):
        return any(item[0] == 'article' and not item[1] for item in self.stack)

    def append(self, value):
        self.parts.append(value)
        if self.in_article():
            self.article_parts.append(value)

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)  # Names are parsed by HTMLParser, never regexed from other values.
        if tag == 'plaintext':
            raise ValueError('unsupported')
        if tag == 'input' and attributes.get('type', '').lower() == 'password':
            raise ValueError('unsupported')
        style = re.sub(r'\s+', '', attributes.get('style') or '').lower()
        hidden = ('hidden' in attributes or (attributes.get('aria-hidden') or '').lower() == 'true'
                  or re.search(r'(?:^|;)(?:display:none|visibility:(?:hidden|collapse))(?:!important)?(?:;|$)', style))
        # Title is separate evidence, including in head; never mix it into article/body text.
        mute = bool(self.muted() or tag in IGNORED or hidden)
        if tag == 'title' and not hidden and all(t in ('html', 'head') for t, _ in self.stack):
            mute = False
        if tag not in VOID:
            if len(self.stack) >= 512:
                raise OverflowError('limit')
            self.stack.append((tag, mute))
        if tag == 'article' and not mute:
            self.articles += 1
        if not mute and tag != 'title':
            if tag in BLOCK:
                self.append('\n- ' if tag == 'li' else '\n')
            if tag in ('td', 'th'):
                self.append(' | ')

    def handle_startendtag(self, tag, attrs):
        # In HTML, '/>' cannot close a non-void active or hidden element.
        self.handle_starttag(tag, attrs)
        if tag in RAW:
            self.set_cdata_mode(tag)

    def handle_endtag(self, tag):
        indices = [i for i, item in enumerate(self.stack) if item[0] == tag]
        if not indices:
            return
        index = indices[-1]
        # Do not let malformed cross-container end tags terminate hidden/active text.
        if any(muted for _, muted in self.stack[index + 1:]):
            raise ValueError('unsupported')
        if not self.muted() and tag in BLOCK:
            self.append('\n')
        del self.stack[index:]

    def handle_data(self, data):
        if self.stack and self.stack[-1][0] == 'title' and not self.stack[-1][1]:
            self.title_parts.append(data)
        elif not self.muted():
            self.append(data)

    def result(self):
        if self.rawdata:
            raise ValueError('unsupported')
        self.close()
        # Ordinary omitted end tags are tolerated; incomplete suppressed/article/title
        # boundaries or unparsed partial markup cannot claim a complete extraction.
        if self.rawdata or any(muted or tag in ('title', 'article') for tag, muted in self.stack):
            raise ValueError('unsupported')
        article = inert(''.join(self.article_parts))
        text = article or inert(''.join(self.parts))
        if not text:
            raise ValueError('unsupported')
        result = {'text': text}
        title = inert(unescape(''.join(self.title_parts)))[:256]
        if title:
            result['title'] = title
        return result


def main():
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (28, 28))
    raw = sys.stdin.buffer.read(LIMIT + 1)
    if len(raw) > LIMIT:
        return 3
    source = raw.decode('utf-8', errors='strict')
    if '\x00' in source:
        return 2
    if sys.argv[1:] == ['text/plain']:
        text = inert(source)
        if not text:
            return 2
        result = {'text': text}
    elif sys.argv[1:] == ['text/html']:
        if re.search(r'\b(?:cf-chl-|g-recaptcha|h-captcha|enable javascript and cookies to continue|sign in to continue|subscribe to continue|verify you are human)\b', source, re.I):
            return 2
        parser = Extract()
        parser.feed(source)
        result = parser.result()
    else:
        return 2
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OverflowError, MemoryError):
        raise SystemExit(3)
    except (ValueError, UnicodeError, RecursionError):
        raise SystemExit(2)
