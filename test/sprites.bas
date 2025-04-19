SUB sprites()
    PRINT "sprites"
END SUB

IF variable = 1 THEN
    PRINT "variable is 1"
END IF


FOR i = 1 TO 10
    PRINT i
    PAPER 1
    INK 0
    sprites()
NEXT i
