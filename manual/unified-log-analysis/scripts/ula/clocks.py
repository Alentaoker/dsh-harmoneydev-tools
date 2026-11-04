"""Clock domains describe comparability, not proof of synchronized devices."""
from datetime import datetime
from .storage import parse_datetime


def value_domain(value, assumed=False):
    if not value:
        return 'none'
    if assumed:
        return 'year_placeholder'
    return 'aware' if parse_datetime(value).tzinfo else 'naive_year'


def file_domain(file):
    return file.get('clockDomain') or value_domain(file.get('timeRange',[None])[0],file.get('yearAssumed',False))


def comparable(a,b):
    return a==b and a not in ('none','mixed',None)
